"""Credential-free, fixed-destination npm tunnel. No workspace or control mounts."""
import http.server
import select
import socket
import threading
import time

HOST = 'registry.npmjs.org'
MAX_TRANSFER = 512 * 1024 * 1024


class RegistryProxy(http.server.BaseHTTPRequestHandler):
    transferred = 0
    lock = threading.Lock()
    slots = threading.BoundedSemaphore(16)

    def log_message(self, *_args):
        pass

    def do_CONNECT(self):
        if self.path != HOST + ':443':
            self.send_error(403, 'registry_denied')
            return
        if not self.slots.acquire(blocking=False):
            self.send_error(429, 'registry_busy')
            return
        try:
            # Fixed destination; client input never chooses an address or port.
            with socket.create_connection((HOST, 443), timeout=30) as upstream:
                self.send_response(200)
                self.end_headers()
                self.connection.settimeout(30)
                upstream.settimeout(30)
                deadline = time.monotonic() + 300
                peers = [self.connection, upstream]
                while time.monotonic() < deadline:
                    readable, _, _ = select.select(peers, [], [], 10)
                    for source in readable:
                        data = source.recv(65536)
                        if not data:
                            return
                        with self.lock:
                            if RegistryProxy.transferred + len(data) > MAX_TRANSFER:
                                return
                            RegistryProxy.transferred += len(data)
                        destination = upstream if source is self.connection else self.connection
                        destination.sendall(data)
        except OSError:
            pass  # No URLs, TLS data or exception strings in logs.
        finally:
            self.slots.release()


if __name__ == '__main__':
    http.server.ThreadingHTTPServer(('0.0.0.0', 8081), RegistryProxy).serve_forever()
