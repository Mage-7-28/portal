"""仅监听 loopback、映射到测试临时目录的 SSH/SFTPv3 服务器。"""

import errno
import os
from pathlib import Path
import socket
import sys
import threading
import time

import paramiko


class Auth(paramiko.ServerInterface):
    """测试使用虚构身份；不读取或验证任何本机账户凭据。"""

    def check_auth_password(self, username, password):
        return (paramiko.AUTH_SUCCESSFUL if (username, password) == ("portal-test", "fixture")
                else paramiko.AUTH_FAILED)

    def get_allowed_auths(self, username):
        return "password"

    def check_channel_request(self, kind, chanid):
        return (paramiko.OPEN_SUCCEEDED if kind == "session"
                else paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED)

    def check_channel_exec_request(self, channel, command):
        if command != b"id -u":
            return False

        def reply():
            # 等待 Paramiko 先发回 exec 请求确认，避免 EOF 先于确认到达客户端。
            time.sleep(0.02)
            channel.sendall(f"{os.getuid()}\n".encode())
            channel.send_exit_status(0)
            channel.close()

        threading.Thread(target=reply, daemon=True).start()
        return True


class Handle(paramiko.SFTPHandle):
    def stat(self):
        return paramiko.SFTPAttributes.from_stat(os.fstat(self.readfile.fileno()))


class Files(paramiko.SFTPServerInterface):
    def __init__(self, server, root):
        super().__init__(server)
        self.root = root

    def local(self, path, follow=True):
        """连同链接目标校验边界，禁止夹具访问临时根目录以外的本机文件。"""
        candidate = self.root / path.lstrip("/")
        checked = candidate.resolve() if follow else candidate.parent.resolve() / candidate.name
        if checked != self.root and self.root not in checked.parents:
            raise PermissionError(errno.EACCES, "outside fixture")
        return candidate

    def stat(self, path):
        try:
            return paramiko.SFTPAttributes.from_stat(self.local(path).stat())
        except OSError as error:
            return paramiko.SFTPServer.convert_errno(error.errno)

    def lstat(self, path):
        try:
            return paramiko.SFTPAttributes.from_stat(self.local(path, False).lstat())
        except OSError as error:
            return paramiko.SFTPServer.convert_errno(error.errno)

    def list_folder(self, path):
        try:
            entries = []
            for child in self.local(path).iterdir():
                entry = paramiko.SFTPAttributes.from_stat(child.lstat())
                entry.filename = os.fsencode(child.name)
                entries.append(entry)
            return entries
        except OSError as error:
            return paramiko.SFTPServer.convert_errno(error.errno)

    def open(self, path, flags, attr):
        try:
            descriptor = os.open(self.local(path), flags, attr.st_mode or 0o600)
            stream = os.fdopen(descriptor, "r+b" if flags & os.O_RDWR else
                               "wb" if flags & os.O_WRONLY else "rb", buffering=0)
            handle = Handle(flags)
            handle.readfile = stream
            handle.writefile = stream
            return handle
        except OSError as error:
            return paramiko.SFTPServer.convert_errno(error.errno)

    def mkdir(self, path, attr):
        try:
            self.local(path).mkdir(mode=attr.st_mode or 0o700)
            return paramiko.SFTP_OK
        except OSError as error:
            return paramiko.SFTPServer.convert_errno(error.errno)

    def remove(self, path):
        try:
            self.local(path, False).unlink()
            return paramiko.SFTP_OK
        except OSError as error:
            return paramiko.SFTPServer.convert_errno(error.errno)

    def rmdir(self, path):
        try:
            self.local(path, False).rmdir()
            return paramiko.SFTP_OK
        except OSError as error:
            return paramiko.SFTPServer.convert_errno(error.errno)

    def rename(self, source, target):
        try:
            source, target = self.local(source, False), self.local(target, False)
            # SFTPv3 RENAME 不允许覆盖；不能用 os.rename 的 POSIX 默认行为伪造成功。
            if target.exists() or target.is_symlink():
                return paramiko.SFTP_FAILURE
            source.rename(target)
            return paramiko.SFTP_OK
        except OSError as error:
            return paramiko.SFTPServer.convert_errno(error.errno)


def main():
    root = Path(sys.argv[1]).resolve(strict=True)
    key = paramiko.RSAKey.generate(2048)
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        print(listener.getsockname()[1], flush=True)
        transports = []
        while True:
            connection, _ = listener.accept()
            transport = paramiko.Transport(connection)
            transport.add_server_key(key)
            transport.set_subsystem_handler("sftp", paramiko.SFTPServer, Files, root=root)
            transport.start_server(server=Auth())
            transports.append(transport)


if __name__ == "__main__":
    main()
