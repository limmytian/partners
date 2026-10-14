# Runs inside the selected workspace runtime. No caller code is evaluated.
import os, sys, json, hashlib, stat, re, base64, secrets

class Failure(Exception):
    def __init__(self, code): self.code = code

def check_sensitive(p):
    parts = p.split('/')
    name = parts[-1]
    if any(x in ('.aws', '.kube', '.docker') for x in parts) or re.search(r'^(\.env(?:\..*)?|\.secrets?(?:\..*)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.gitconfig|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.(bash|zsh|sh|python)_history)$', name, re.I) or re.search(r'\.(pem|key|pkcs12|pfx|p12)$', name, re.I):
        raise Failure('FORBIDDEN')

def parent(root, path, create=False):
    parts = path.split('/')
    if path.startswith('/') or '\x00' in path or '\\' in path or '..' in parts: raise Failure('INVALID_ARGUMENT')
    parts = [p for p in parts if p not in ('', '.')]
    fd = os.dup(root)
    try:
        for item in parts[:-1]:
            try: child = os.open(item, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            except FileNotFoundError:
                if not create: raise
                try: os.mkdir(item, 0o700, dir_fd=fd)
                except FileExistsError: pass
                child = os.open(item, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd); fd = child
        return fd, parts[-1] if parts else '.'
    except Exception:
        os.close(fd); raise

def open_file(fd, name):
    f = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    info = os.fstat(f)
    if not stat.S_ISREG(info.st_mode): os.close(f); raise Failure('INVALID_ARGUMENT')
    if info.st_size > 64 * 1024 * 1024: os.close(f); raise Failure('FILE_TOO_LARGE')
    return f, info

def digest(fd):
    h = hashlib.sha256(); os.lseek(fd, 0, os.SEEK_SET)
    while True:
        chunk = os.read(fd, 65536)
        if not chunk: break
        h.update(chunk)
    return h.hexdigest()

def read(fd, name, a):
    f, info = open_file(fd, name)
    try:
        sha = digest(f); offset = a['offsetBytes']
        os.lseek(f, offset, os.SEEK_SET)
        data = os.read(f, a['maxBytes'] + 4)
        if b'\x00' in data: raise Failure('BINARY_UNSUPPORTED')
        if data and data[0] & 0xc0 == 0x80: raise Failure('INVALID_ARGUMENT')
        end = min(len(data), a['maxBytes'])
        while end < len(data) and end > 0 and data[end] & 0xc0 == 0x80: end -= 1
        try: text = data[:end].decode('utf-8')
        except UnicodeDecodeError: raise Failure('BINARY_UNSUPPORTED')
        return {'path': a['path'], 'content': text, 'hash': sha, 'sizeBytes': info.st_size,
                'nextOffsetBytes': offset + end, 'truncated': offset + end < info.st_size}
    finally: os.close(f)

def write(fd, name, a):
    data = a['content'].encode('utf-8')
    if len(data) > 262144: raise Failure('FILE_TOO_LARGE')
    original = None
    try:
        f, info = open_file(fd, name)
        try: original = (info.st_dev, info.st_ino, info.st_mtime_ns, info.st_size, digest(f))
        finally: os.close(f)
    except FileNotFoundError: pass
    if a.get('createOnly'):
        if original is not None: raise Failure('WRITE_CONFLICT')
    elif original is None or original[-1] != a.get('expectedHash'): raise Failure('WRITE_CONFLICT')
    temp = '.partners-mcp-' + secrets.token_hex(16)
    f = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
    try:
        with os.fdopen(f, 'wb') as stream: stream.write(data); stream.flush(); os.fsync(stream.fileno())
        if a.get('createOnly'):
            try: os.link(temp, name, src_dir_fd=fd, dst_dir_fd=fd, follow_symlinks=False)
            except FileExistsError: raise Failure('WRITE_CONFLICT')
        else:
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if not stat.S_ISREG(info.st_mode) or (info.st_dev, info.st_ino, info.st_mtime_ns, info.st_size) != original[:4]: raise Failure('WRITE_CONFLICT')
            os.replace(temp, name, src_dir_fd=fd, dst_dir_fd=fd)
        os.fsync(fd)
        return {'path': a['path'], 'hash': hashlib.sha256(data).hexdigest(), 'sizeBytes': len(data)}
    finally:
        try: os.unlink(temp, dir_fd=fd)
        except FileNotFoundError: pass

def listing(fd, name, a):
    directory = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
    identity = hashlib.sha256(json.dumps([a['path'], a['depth']], separators=(',', ':')).encode()).hexdigest()
    after = 0
    if a.get('cursor'):
        try:
            decoded = json.loads(base64.urlsafe_b64decode(a['cursor']))
            if decoded['identity'] != identity: raise ValueError()
            after = decoded['after']
            if not isinstance(after, int) or after < 0: raise ValueError()
        except Exception: raise Failure('INVALID_ARGUMENT')
    entries, scanned, visited = [], [0], [0]
    def scan(current, prefix, depth):
        names = []
        with os.scandir(current) as it:
            for entry in it:
                scanned[0] += 1
                if scanned[0] > 10000: raise Failure('DIRECTORY_TOO_LARGE')
                names.append(entry.name)
        for name in sorted(names):
            relative = prefix + name
            try: check_sensitive(relative)
            except Failure: continue
            info = os.stat(name, dir_fd=current, follow_symlinks=False)
            if stat.S_ISLNK(info.st_mode): continue
            is_dir = stat.S_ISDIR(info.st_mode)
            if not is_dir and not stat.S_ISREG(info.st_mode): continue
            visited[0] += 1
            if visited[0] > after:
                entries.append({'path': relative, 'type': 'directory' if is_dir else 'file', 'sizeBytes': None if is_dir else info.st_size})
                if len(entries) > a['limit']: return True
            if is_dir and depth < a['depth']:
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
                try:
                    if scan(child, relative + '/', depth + 1): return True
                finally: os.close(child)
        return False
    try: more = scan(directory, '', 0)
    finally: os.close(directory)
    selected = entries[:a['limit']]
    cursor = base64.urlsafe_b64encode(json.dumps({'identity': identity, 'after': after + len(selected)}).encode()).decode() if more and selected else None
    return {'path': a['path'], 'entries': selected, 'nextCursor': cursor}

root = None
try:
    a = json.loads(''.join(sys.argv[2:]))
    check_sensitive(a['path'])
    root = os.open(sys.argv[1], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    fd, name = parent(root, a['path'], a['action'] == 'write' and a.get('createOnly') is True)
    try:
        if a['action'] == 'read': value = read(fd, name, a)
        elif a['action'] == 'write': value = write(fd, name, a)
        else: value = listing(fd, name, a)
    finally: os.close(fd)
    print(json.dumps({'ok': True, 'result': value}, ensure_ascii=False))
except Failure as e: print(json.dumps({'ok': False, 'code': e.code}))
except FileNotFoundError: print(json.dumps({'ok': False, 'code': 'NOT_FOUND'}))
except PermissionError: print(json.dumps({'ok': False, 'code': 'FORBIDDEN'}))
except OSError: print(json.dumps({'ok': False, 'code': 'INVALID_ARGUMENT'}))
finally:
    if root is not None: os.close(root)
