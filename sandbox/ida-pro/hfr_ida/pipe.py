"""The plugin's named pipe: the only way into its tools.

Harness for REA (specs/ida-pro R2.2, R2.6, adr:0027-ship-a-read-only-ida-plugin-on-a-named-pipe). It speaks
the framing of the app's Cheat Engine bridge — each message a 4-byte little-endian length and a JSON-RPC 2.0
body — on \\\\.\\pipe\\hfr-ida, one client at a time, one pipe instance, so a second IDA never answers for
the first, and no remote client. A method that is neither an internal one nor in the tool table gets -32601
and runs nothing. `dispatch` imports nothing from IDA, so it runs outside IDA too.
"""

import inspect
import json
import struct
import sys
import threading
from typing import Any, Callable

PIPE_NAME = r"\\.\pipe\hfr-ida"
# The largest request read; the app sends a few kilobytes.
REQUEST_CAP = 1024 * 1024
# The largest answer written; the app refuses one past this too.
ANSWER_CAP = 32 * 1024 * 1024

METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
TOOL_ERROR = -32000


def _error(id_: Any, code: int, message: str) -> dict:
    return {"jsonrpc": "2.0", "id": id_, "error": {"code": code, "message": message}}


def dispatch(message: Any, internal: dict[str, Callable[[], Any]], tools: dict[str, Callable]) -> dict:
    """One request's answer: an internal method, a tool of the table, or -32601."""
    if not isinstance(message, dict):
        return _error(None, INVALID_PARAMS, "A request is a JSON-RPC object.")
    id_ = message.get("id")
    method = message.get("method")
    params = message.get("params") or {}
    if not isinstance(method, str):
        return _error(id_, INVALID_PARAMS, "A request names its method.")
    if not isinstance(params, dict):
        return _error(id_, INVALID_PARAMS, "A request's params are an object.")
    if method in internal:
        fn: Callable = internal[method]
        params = {}
    elif method in tools:
        fn = tools[method]
    else:
        return _error(id_, METHOD_NOT_FOUND, f"Method not found: {method}")
    try:
        inspect.signature(fn).bind(**params)
    except TypeError as e:
        return _error(id_, INVALID_PARAMS, f"Invalid params for {method}: {e}")
    try:
        result = fn(**params)
    except Exception as e:
        return _error(id_, TOOL_ERROR, str(e) or type(e).__name__)
    return {"jsonrpc": "2.0", "id": id_, "result": result}


def encode(answer: dict) -> bytes:
    """The framed answer; one past the cap is answered with an error instead."""
    body = json.dumps(answer, default=str, separators=(",", ":")).encode("utf-8")
    if len(body) > ANSWER_CAP:
        body = json.dumps(
            _error(answer.get("id"), TOOL_ERROR, f"The answer is larger than {ANSWER_CAP // (1024 * 1024)} MB; ask for less."),
        ).encode("utf-8")
    return struct.pack("<I", len(body)) + body


class PipeServer:
    """Serves the pipe on a thread of its own until stopped. Windows only."""

    def __init__(self, internal: dict[str, Callable[[], Any]], tools: dict[str, Callable], log: Callable[[str], None] = print):
        self.internal = internal
        self.tools = tools
        self.log = log
        self._stop = threading.Event()
        self._thread: "threading.Thread | None" = None
        self._handle = None
        self._k32 = None

    def start(self) -> bool:
        """Opens the pipe and starts serving; False when another IDA already holds it."""
        if sys.platform != "win32":
            self.log("[hfr-ida] The pipe needs Windows; the plugin stays idle.")
            return False
        import ctypes
        from ctypes import wintypes

        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.CreateNamedPipeW.restype = wintypes.HANDLE
        k32.CreateNamedPipeW.argtypes = [
            wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD,
            wintypes.DWORD, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID,
        ]
        k32.ConnectNamedPipe.argtypes = [wintypes.HANDLE, wintypes.LPVOID]
        k32.DisconnectNamedPipe.argtypes = [wintypes.HANDLE]
        k32.ReadFile.argtypes = [wintypes.HANDLE, wintypes.LPVOID, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), wintypes.LPVOID]
        k32.WriteFile.argtypes = [wintypes.HANDLE, wintypes.LPCVOID, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), wintypes.LPVOID]
        k32.FlushFileBuffers.argtypes = [wintypes.HANDLE]
        k32.CloseHandle.argtypes = [wintypes.HANDLE]
        k32.OpenThread.restype = wintypes.HANDLE
        k32.OpenThread.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        k32.CancelSynchronousIo.argtypes = [wintypes.HANDLE]
        self._k32 = k32

        PIPE_ACCESS_DUPLEX = 0x00000003
        FILE_FLAG_FIRST_PIPE_INSTANCE = 0x00080000
        PIPE_TYPE_BYTE_WAIT = 0x00000000
        PIPE_REJECT_REMOTE_CLIENTS = 0x00000008
        INVALID = wintypes.HANDLE(-1).value
        handle = k32.CreateNamedPipeW(
            PIPE_NAME,
            PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_TYPE_BYTE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            1,
            65536,
            65536,
            0,
            None,
        )
        if handle in (None, 0, INVALID):
            err = ctypes.get_last_error()
            self.log(f"[hfr-ida] Could not open {PIPE_NAME} (error {err}); another IDA may hold it. The agents reach that one.")
            return False
        self._handle = handle
        self._stop.clear()
        self._thread = threading.Thread(target=self._serve, name="hfr-ida-pipe", daemon=True)
        self._thread.start()
        self.log(f"[hfr-ida] Serving the app on {PIPE_NAME}.")
        return True

    def stop(self) -> None:
        self._stop.set()
        thread, k32 = self._thread, self._k32
        if thread and k32:
            # The thread blocks in ConnectNamedPipe or ReadFile; cancelling its synchronous I/O wakes it.
            THREAD_TERMINATE = 0x0001
            for _ in range(20):
                if not thread.is_alive():
                    break
                th = k32.OpenThread(THREAD_TERMINATE, False, thread.native_id)
                if th:
                    k32.CancelSynchronousIo(th)
                    k32.CloseHandle(th)
                thread.join(0.1)
        if self._handle is not None and k32:
            k32.CloseHandle(self._handle)
        self._handle = None
        self._thread = None

    def _read(self, n: int) -> "bytes | None":
        import ctypes
        from ctypes import wintypes

        out = bytearray()
        while len(out) < n:
            buf = ctypes.create_string_buffer(min(n - len(out), 65536))
            got = wintypes.DWORD(0)
            if not self._k32.ReadFile(self._handle, buf, len(buf), ctypes.byref(got), None) or got.value == 0:
                return None
            out += buf.raw[: got.value]
        return bytes(out)

    def _write(self, data: bytes) -> bool:
        import ctypes
        from ctypes import wintypes

        view = memoryview(data)
        while len(view):
            done = wintypes.DWORD(0)
            if not self._k32.WriteFile(self._handle, bytes(view[:65536]), min(len(view), 65536), ctypes.byref(done), None):
                return False
            view = view[done.value :]
        return True

    def _serve(self) -> None:
        import ctypes

        ERROR_PIPE_CONNECTED = 535
        k32 = self._k32
        while not self._stop.is_set():
            if not k32.ConnectNamedPipe(self._handle, None) and ctypes.get_last_error() != ERROR_PIPE_CONNECTED:
                if self._stop.is_set():
                    break
                k32.DisconnectNamedPipe(self._handle)
                # A pipe that keeps failing is retried slowly rather than spun on.
                self._stop.wait(0.2)
                continue
            try:
                while not self._stop.is_set():
                    head = self._read(4)
                    if head is None:
                        break
                    (n,) = struct.unpack("<I", head)
                    if n > REQUEST_CAP:
                        self._write(encode(_error(None, INVALID_PARAMS, "The request is too large.")))
                        break
                    body = self._read(n)
                    if body is None:
                        break
                    try:
                        message = json.loads(body.decode("utf-8"))
                    except (UnicodeDecodeError, json.JSONDecodeError):
                        answer = _error(None, INVALID_PARAMS, "The request is not JSON.")
                    else:
                        answer = dispatch(message, self.internal, self.tools)
                    if not self._write(encode(answer)):
                        break
            except Exception as e:
                self.log(f"[hfr-ida] The connection failed: {e}")
            finally:
                k32.FlushFileBuffers(self._handle)
                k32.DisconnectNamedPipe(self._handle)
