# Server Triage Sheet

Commands and error meanings for a broken host, service or database. Each entry is a command or an error message, then what it tells you and where to look next. Placeholders in capitals (HOST, PID, POD, SVC, APP) are yours to fill.

Written for Linux with systemd, OpenSSL 1.1.1 or later, PostgreSQL 13+, MySQL 8.0 and Redis 6+. Searchable, click-to-copy and offline: [the app](https://makavli.github.io/server-triage/).

## The loop

Six steps that work for any outage, from a 502 to a full disk.

1. **Pin the symptom.** The exact error text, when it started, who is hit: everyone, one node, one region, a percentage. "Slow" needs a number.
2. **Ask what changed.** A deploy, a config push, an expiring cert, a rotated secret, a traffic shift, a dependency, a filling disk, the clock.
3. **Walk the path.** Test each hop from the client inward: DNS, network, TLS, load balancer, proxy, app, database. Stop at the first that fails.
4. **Read the first error.** Logs fill up with the cascade. Go to the earliest timestamp and the first distinct message.
5. **Diff against healthy.** Another node, the previous release, staging. Compare config, versions, environment, resolved IPs.
6. **Capture, then mitigate.** Save logs, `ss` output and thread dumps before a restart. Roll back before fixing forward. Root cause comes after recovery.

## First minute on a host

Brendan Gregg's 60-second checklist. Run it top to bottom before forming a theory. `mpstat`, `pidstat`, `iostat` and `sar` come from the sysstat package.

```sh
uptime
```

Load averages over 1, 5 and 15 minutes; compare with `nproc`. Linux also counts tasks blocked on disk or NFS, so high load with an idle CPU points to IO.

```sh
dmesg -T | tail -50
```

The kernel's view: OOM kills, disk and filesystem errors, NIC resets, "nf_conntrack: table full", segfaults.

```sh
vmstat 1 5
```

**r** above the core count: CPU saturated. **b**: tasks stuck on IO. **si/so** above 0: swapping. **wa**: IO wait. **st**: CPU stolen by the hypervisor.

```sh
mpstat -P ALL 1 3
```

One core pinned while the rest idle: a single-threaded hot loop, or interrupts landing on one CPU.

```sh
pidstat 1 5
```

CPU per process over several seconds. Catches spiky processes a single `top` snapshot misses.

```sh
iostat -xz 1 3
```

**r_await** and **w_await** are latency in ms, **aqu-sz** the queue. `%util` near 100 means saturated only on single-queue disks; SSD and NVMe serve requests in parallel.

```sh
free -m
```

Read **available**, not free. buff/cache is memory the kernel gives back on demand.

```sh
sar -n DEV 1 3
```

Throughput per interface. Compare rxkB/s and txkB/s with the link speed.

```sh
sar -n TCP,ETCP 1 3
```

**active/s**: outbound connects. **passive/s**: inbound. **retrans/s** above a handful: packet loss or an overloaded peer.

```sh
top
```

Confirm the process the steps above pointed at. Press 1 for each core, M to sort by memory, P by CPU.

## Error decoder

The message the kernel or libc hands you, what it really means, and where to look next.

```text
Connection refused
```

The host answered with a reset: it is up, but nothing listens on that IP and port. **Check** the service runs, the port is right, and it is not bound to 127.0.0.1 (`ss -tlnp`).

```text
Connection timed out
```

No answer at all. A firewall or security group drops the packets, the route is wrong, or the host is down. **Check** with `tcpdump` for a SYN with no reply.

```text
No route to host
```

An ICMP unreachable came back: the host is down on the local network (ARP fails) or a firewall rule REJECTs. **Check** `ip route get IP` and the rules.

```text
Temporary failure in name resolution
Name or service not known
```

DNS: a typo, a wrong search domain, or an unreachable resolver. **Check** `getent hosts NAME` against `dig NAME`.

```text
Connection reset by peer
```

The other side aborted: its process crashed or was killed, a load balancer idle timeout fired, or a proxy rejected the request. **Check** the peer's logs at that second.

```text
Broken pipe
```

You wrote to a socket the peer had already closed. Same causes as a reset, seen from the writer.

```text
Cannot assign requested address
```

On connect: ephemeral ports to one destination are used up, usually by TIME_WAIT. On bind: that IP is not on this host. **Fix** by reusing connections (keep-alive, pools).

```text
Address already in use
```

Another process holds the port: `ss -tlnp 'sport = :8080'`. A server that restarts fast also needs SO_REUSEADDR.

```text
Too many open files
```

The process hit its file descriptor limit: a leak or a low limit. **Check** `ls /proc/PID/fd | wc -l` against `/proc/PID/limits`; raise `LimitNOFILE=` in the unit.

```text
No space left on device
```

Out of blocks or out of inodes (`df -h`, `df -i`). From a file watcher it means `fs.inotify.max_user_watches` is used up, not the disk.

```text
Permission denied
```

File mode or owner, a parent directory without x, SELinux or AppArmor, or a port under 1024 without CAP_NET_BIND_SERVICE. **Check** `namei -l /path` and `ausearch -m avc -ts recent`.

```text
Operation not permitted
```

A missing capability (common in containers), a seccomp filter, or an immutable file (`lsattr`). Being root does not bypass these.

```text
Read-only file system
```

The kernel remounted the filesystem after IO errors (see `dmesg`), or a container runs with a read-only root.

```text
fork: Resource temporarily unavailable
```

Process or thread limit: `ulimit -u`, the cgroup's `pids.max`, `kernel.pid_max`. Often a thread leak.

```text
Killed
```

SIGKILL, exit 137: often the OOM killer or a cgroup memory limit; **check** `dmesg -T | grep -i 'killed process'`. If the kernel log is clean, someone sent `kill -9`, or systemd killed it when it outlived `TimeoutStopSec=` (`journalctl -u UNIT`).

```text
/usr/bin/env: 'bash\r': No such file or directory
```

The script has Windows line endings. **Fix** with `sed -i 's/\r$//' script.sh` and prevent it with `git config core.autocrlf input`.

```text
small requests work, big ones hang
```

An MTU black hole: a tunnel, VPN or overlay lowers the MTU and the ICMP "fragmentation needed" reply is blocked. **Check** with the `ping -M do` test under DNS, ports and packets.

## Services and logs

systemd and journald on most distributions. Read the unit before you trust what you think it runs.

### systemd

```sh
systemctl status APP
```

State, main PID, memory, the last log lines and the exit status in one view.

```sh
systemctl --failed
```

Every unit that failed since boot.

```sh
systemctl cat APP
```

The unit file plus every drop-in: what actually runs, as which user, with which environment and limits.

```sh
systemctl show APP -p NRestarts,Result,ExecMainStatus
```

How many times it restarted and how the last run ended.

```sh
systemctl reset-failed APP
```

Clears "start request repeated too quickly" (StartLimitBurst hit) once you have fixed the cause.

### Logs

```sh
journalctl -u APP -b -p warning --no-pager
```

This boot, warnings and worse, for one unit.

```sh
journalctl -u APP --since "15 min ago" -f
```

Recent history, then follow.

```sh
journalctl --since "09:00" --until "09:15"
```

Every unit in the incident window. The neighbour that failed first is often the cause.

```sh
journalctl -k -b -1
```

Kernel log of the previous boot: why it rebooted. Needs a persistent journal (`/var/log/journal` exists).

```sh
tail -F /var/log/app/app.log
```

`-F` keeps following across log rotation; `-f` stays on the rotated-away file.

```sh
grep ERROR app.log | cut -c1-16 | uniq -c
```

Errors per minute for ISO timestamps. The spike shows when it started.

```sh
zgrep -h 'req_id=abc123' /var/log/app/app.log*
```

Searches rotated and compressed logs too.

### Exit codes

```text
exit 1
```

A generic failure from the app itself. Its own log has the reason.

```text
exit 126
```

Found but not executable: permissions, or a noexec mount.

```text
exit 127
```

Command not found: PATH, a missing binary, the wrong image.

```text
exit 137
```

128 + 9, SIGKILL: the OOM killer, a cgroup memory limit, or someone's `kill -9`.

```text
exit 139
```

128 + 11, SIGSEGV: a crash in native code. `coredumpctl list`, then `coredumpctl gdb PID`.

```text
exit 143
```

128 + 15, SIGTERM: a normal stop. A problem only when nobody asked it to stop.

```text
status=203/EXEC
```

systemd could not exec `ExecStart`: wrong path, not executable, a bad shebang, or CRLF line endings.

```text
status=200/CHDIR
```

`WorkingDirectory=` does not exist.

```text
status=217/USER
```

`User=` does not exist on this host.

## CPU, memory, disk, files

Where the machine's limits are, and which process is pressing on them.

```sh
ps aux --sort=-%mem | head
```

Top memory users by RSS. Use `--sort=-%cpu` for CPU.

```sh
systemd-cgtop
```

CPU, memory and IO per cgroup, so per service or per container.

```sh
dmesg -T | grep -iE 'killed process|out of memory'
```

Which process the OOM killer chose, and its RSS at that moment.

```sh
df -hT
```

Space per filesystem, with its type.

```sh
df -i
```

Inodes. 100% used with free space left means millions of small files: sessions, a cache, a mail queue.

```sh
sudo ionice -c3 du -xhd1 / 2>/dev/null | sort -h | tail
```

Biggest directories; `-x` stays on one filesystem. As root so no directory is skipped, at idle I/O priority so it does not starve the disk. Repeat one level down.

```sh
lsof +L1
```

Deleted files still held open. When `df` says full and `du` cannot find it, it is usually these; otherwise files hidden under a mount point (`mount --bind / /mnt` and run `du` on `/mnt`). Restart the holder. For a log only, truncate it with `: > /proc/PID/fd/N`, after copying it to another filesystem if you need it. Never truncate a live database file or WAL: the process still uses it. A writer that does not append keeps its offset, so the file comes back sparse.

```sh
ls /proc/PID/fd | wc -l
```

Open descriptors. Compare with `grep 'open files' /proc/PID/limits`; a count that keeps climbing is a leak.

```sh
sudo timeout 10 strace -f -tt -p PID -e trace=network,file
```

What a stuck or slow process is doing, syscall by syscall. It slows the target a lot: seconds, not minutes, in production. Stop it with Ctrl-C or `timeout`, never `kill -9`: a strace killed hard can leave the target stopped (`kill -CONT PID`).

```sh
sudo timeout 10 strace -c -f -p PID
```

A syscall summary after 10 seconds: time spent in futex, read, poll, connect.

```sh
sudo cat /proc/PID/stack
```

Where a process in state D waits inside the kernel.

```sh
sudo perf top -p PID
```

Hot functions live, kernel and user space. Needs root, or a low `kernel.perf_event_paranoid`.

```sh
timedatectl
```

Clock and NTP sync. Skew breaks TLS validity, JWT expiry, Kerberos and distributed locks.

## DNS, ports and packets

Resolve, then reach, then read the sockets, then look at the packets. Each layer answers before the next is worth asking.

### Resolve

```sh
getent hosts NAME
```

Resolves the way the app does, through nsswitch: `/etc/hosts` first, then DNS.

```sh
dig +short NAME
```

DNS only. A different answer from `getent` means `/etc/hosts` or a search domain is involved.

```sh
dig @RESOLVER NAME +noall +answer
```

Asks one specific resolver and shows the TTL left on the record. A stale cache shows here.

```sh
resolvectl status
```

The upstream servers systemd-resolved really uses. 127.0.0.53 in `resolv.conf` is only its local stub.

### Reach

```sh
ip -br addr
```

Interfaces, state and addresses, one line each.

```sh
ip route get IP
```

The interface, gateway and source address the kernel would use for that destination.

```sh
nc -zv -w3 HOST 5432
```

Is the TCP port open from here.

```sh
timeout 3 bash -c '</dev/tcp/HOST/5432' && echo open
```

The same check on a minimal host without `nc`.

```sh
mtr -rwc 50 HOST
```

Loss and latency per hop. Loss at a middle hop that does not carry on to the end is ICMP rate limiting; ignore it.

```sh
ping -M do -s 1472 HOST
```

Path MTU test: 1472 bytes plus 28 of headers fills 1500. Lower the size until replies come back.

### Sockets

```sh
ss -tlnp
```

What listens, on which address, owned by which process. 127.0.0.1 is local only; 0.0.0.0 or [::] is every interface.

```sh
ss -tnp 'dport = :5432'
```

Open connections to a port (here the database) with the owning process.

```sh
ss -s
```

Totals per state. The fast way to spot thousands of TIME_WAIT or CLOSE_WAIT.

```sh
ss -ltn
```

On a LISTEN socket, Recv-Q is the accept queue now and Send-Q its limit. Recv-Q near Send-Q: the app is not accepting fast enough.

```sh
nstat -az | grep -iE 'listen|retrans'
```

Kernel counters. ListenOverflows and ListenDrops are connections lost to a full accept queue.

### Packets and firewall

```sh
tcpdump -i any -nn 'host IP and port 443'
```

A SYN with no reply: dropped on the way. A SYN answered by a RST: port closed. Add `-w cap.pcap` for Wireshark.

```sh
nft list ruleset
```

Every firewall rule on a modern distribution. The `iptables` command is often a front end to it.

```sh
iptables -L -n -v --line-numbers
```

Rules with packet counters. Run it twice and watch which counter climbs. It shows the filter table only: add `-t nat` for the port forwarding and masquerading of Docker and kube-proxy.

```sh
sysctl net.netfilter.nf_conntrack_count net.netfilter.nf_conntrack_max
```

The connection tracking table. When it is full the kernel drops new connections and logs "table full" in `dmesg`.

### Socket states

```text
CLOSE_WAIT piling up
```

The peer closed and your app never called `close()`. A socket leak in your code; the network is fine.

```text
TIME_WAIT in thousands
```

Normal on the side that closes first. A problem only when it exhausts ports to one destination. Reuse connections instead of tuning it away.

```text
SYN_SENT stuck
```

Your SYN gets no answer: a firewall drop, a security group, a wrong route.

```text
SYN_RECV piling up
```

Handshakes not completing: a SYN flood, or replies leaving by another path (asymmetric routing).

## TLS and certificates

Most TLS outages are an expiry, a missing intermediate, a name that is not in the certificate, or a wrong clock.

```sh
openssl s_client -connect HOST:443 -servername HOST -verify_hostname HOST </dev/null
```

The handshake, the chain the server sends, and "Verify return code: 0 (ok)". Without `-verify_hostname`, 0 (ok) means only that the chain is trusted, not that the certificate is for HOST. `-servername` (SNI) matters when you connect to an IP: without it you may get the default certificate.

```sh
openssl s_client -connect HOST:443 -servername HOST </dev/null 2>/dev/null | openssl x509 -noout -subject -issuer -dates -ext subjectAltName
```

Who the certificate is for, who signed it, when it expires, and the names it covers.

```sh
openssl s_client -connect HOST:443 -servername HOST -showcerts </dev/null
```

Every certificate sent. A missing intermediate works in browsers (they fetch it) and fails in curl, Java, Go and Python.

```sh
openssl x509 -in cert.pem -noout -checkend 604800
```

Exits 1 if the certificate expires within 7 days. Ready for a cron job or a probe.

```sh
openssl x509 -in cert.pem -noout -pubkey | sha256sum
openssl pkey -in key.pem -pubout | sha256sum
```

The two hashes must match, or the key does not belong to the certificate.

```sh
curl -v --resolve HOST:443:10.0.0.5 https://HOST/health
```

Hits one backend with the real hostname and SNI, bypassing DNS and the load balancer.

### TLS errors

```text
certificate has expired
```

Expired, or this machine's clock is wrong (`timedatectl`). "Not yet valid" is almost always the clock.

```text
unable to get local issuer certificate
```

The chain does not reach a trusted root: the server omits the intermediate, or the client lacks your private CA. Add the CA as a `.crt` file to `/usr/local/share/ca-certificates` and run `update-ca-certificates` (Debian, Ubuntu), or to `/etc/pki/ca-trust/source/anchors` and run `update-ca-trust` (RHEL, Fedora).

```text
no alternative certificate subject name matches
```

The hostname is not in the SAN list (modern clients ignore CN), or SNI picked the wrong certificate.

```text
wrong version number
```

You spoke TLS to a plain HTTP port, or HTTP to a TLS port.

```text
handshake failure
```

No TLS version or cipher in common, or the server demands a client certificate (mTLS).

## HTTP, proxies, load balancers

The status code tells you which layer gave up. The proxy's error log tells you why.

```sh
curl -so /dev/null -w 'dns %{time_namelookup} tcp %{time_connect} tls %{time_appconnect} ttfb %{time_starttransfer} total %{time_total} code %{http_code}\n' https://HOST/
```

Where the time goes. Every value is cumulative seconds, so ttfb minus tls is the server's thinking time.

```sh
curl -sv -H 'Host: app.example.com' http://10.0.0.5:8080/health
```

One backend directly, with the virtual host it expects.

```sh
nginx -t && nginx -s reload
```

Validate, then reload without dropping connections. A failed test leaves the running config alone.

```sh
nginx -T
```

The whole config with every include expanded, as nginx parses it now. It prints any secret written in the config (an `Authorization` header, a password in an upstream URL): mind where you paste it.

```sh
tail -f /var/log/nginx/error.log
```

Upstream failures are logged here, not in `access.log`.

```sh
awk '{print $9}' access.log | sort | uniq -c | sort -rn
```

Count per status code (field 9 in the default combined format).

```sh
awk '{print $1}' access.log | sort | uniq -c | sort -rn | head
```

Top client IPs: a scraper, a retry storm, a broken health check.

### Status codes

```text
500
```

The app threw. Its logs have the stack trace.

```text
502 Bad Gateway
```

The proxy got no valid response: upstream down, refused, crashed mid-response, wrong port, or plain HTTP sent to an HTTPS upstream. Random 502s: see the keep-alive rule below.

```text
503 Service Unavailable
```

No healthy upstream: every backend fails its health check, a Kubernetes Service has no ready endpoints, or the app is shedding load.

```text
504 Gateway Timeout
```

The upstream accepted but answered too late (nginx `proxy_read_timeout`, 60 s by default). Often a slow query or a lock wait behind it.

```text
499
```

nginx only: the client hung up first. Its timeout is shorter than your response time.

```text
413 Request Entity Too Large
```

Body over nginx `client_max_body_size`, which defaults to 1m.

```text
400 Request Header Or Cookie Too Large
```

Cookies piled up. Raise `large_client_header_buffers` or clear them.

```text
401 Unauthorized
```

Credentials missing or invalid.

```text
403 Forbidden
```

Known but not allowed. From nginx itself, often file permissions or a deny rule.

```text
429 Too Many Requests
```

Rate limited, by you or by an upstream. Honour Retry-After.

### nginx error log

```text
connect() failed (111: Connection refused) while connecting to upstream
```

Nothing listens at the upstream address.

```text
upstream timed out (110: Connection timed out)
```

A slow upstream, or packets to it dropped.

```text
upstream prematurely closed connection
```

The app died mid-request, or closed a keep-alive connection nginx was reusing.

```text
no live upstreams
```

Every server in the upstream block is marked failed (`max_fails` within `fail_timeout`).

```text
(13: Permission denied) while connecting to upstream
```

SELinux stops nginx from opening connections. Confirm with `ausearch -m avc -ts recent`. `setsebool -P httpd_can_network_connect 1` fixes it by letting every web server process connect to any port, and `-P` keeps that across reboots: a wide change to the policy, so make it on purpose.

### Three rules that prevent the strange ones

- **Keep-alive.** The backend's idle timeout must be longer than the proxy's or the load balancer's. Otherwise the proxy reuses a socket the backend just closed and you get random 502s. Node's `keepAliveTimeout` defaults to 5 s; an AWS ALB keeps idle connections for 60 s.
- **Timeouts shrink inward.** Client, then load balancer, proxy, app and the database's `statement_timeout`, each shorter than the one outside it. The innermost layer then fails first and reports the real cause.
- **Retry at one layer.** Only idempotent requests, with backoff and jitter. Three layers making three attempts each turn one failure into 27 requests.

## Containers and Kubernetes

The container's exit code and the pod's Events answer most questions before any log does.

### Docker

```sh
docker ps -a --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
```

Status shows exit codes ("Exited (137) 2 minutes ago"); Ports shows what is published to the host.

```sh
docker logs -t --since 10m APP
```

The container's stdout and stderr with timestamps.

```sh
docker inspect -f '{{.State.ExitCode}} oom={{.State.OOMKilled}} {{.State.Error}}' APP
```

Why it stopped. `oom=true` is the memory limit.

```sh
docker stats --no-stream
```

CPU, memory against its limit, network and block IO per container.

```sh
docker run --rm -it --network container:APP nicolaka/netshoot
```

Debug tools inside the container's network namespace. Works for distroless images with no shell.

```sh
docker system df
```

Space taken by images, containers, volumes and the build cache.

```text
works inside the container, refused from outside
```

The app binds 127.0.0.1 inside the container. Bind 0.0.0.0, and check the port is published.

### kubectl

```sh
kubectl get pods -A -o wide
```

READY, STATUS, RESTARTS and the node, cluster-wide. Restarts above 0 deserve a look.

```sh
kubectl describe pod POD
```

The Events at the bottom say why: scheduling, image pulls, failed probes, OOM.

```sh
kubectl logs POD -c CTR --previous
```

Logs of the instance that crashed, not the fresh one.

```sh
kubectl get events -A --sort-by=.lastTimestamp | tail -30
```

The cluster's recent story across every namespace.

```sh
kubectl get endpointslices -l kubernetes.io/service-name=SVC
```

Empty: the Service selector matches no pod, or no pod is Ready.

```sh
kubectl debug -it POD --image=nicolaka/netshoot --target=CTR
```

An ephemeral debug container that shares the target's process namespace.

```sh
kubectl run dns --rm -it --restart=Never --image=busybox:1.36 -- nslookup SVC.NS.svc.cluster.local
```

Cluster DNS, tested from inside a pod.

```sh
kubectl port-forward svc/SVC 8080:80
```

Reaches the Service directly, skipping the ingress. Tells you which side is broken. It picks one pod behind the Service and stays on it, with no load balancing, and it stops when that pod goes away.

```sh
kubectl top pod -A --sort-by=memory
```

Live usage. Needs metrics-server.

```sh
kubectl rollout undo deploy/APP
```

Back to the previous ReplicaSet. `kubectl rollout history deploy/APP` lists them.

```sh
kubectl auth can-i --list --as=system:serviceaccount:NS:SA -n NS
```

What a service account may do, for "forbidden" errors.

### Pod states

```text
Pending
```

Cannot be scheduled. `describe` says why: Insufficient cpu or memory (requests too big), taints, node selectors, an unbound PVC.

```text
ImagePullBackOff
```

Wrong image name or tag, or a private registry without imagePullSecrets. On kind, load the image with `kind load docker-image IMG` and avoid `:latest`, which forces a pull.

```text
CrashLoopBackOff
```

The process keeps exiting. Read `logs --previous`, then the command, args, env and mounted config. A liveness probe killing a slow starter looks the same: add a startupProbe.

```text
OOMKilled
```

The container hit its memory limit (exit 137). Raise the limit or fix the leak; size JVM or V8 heaps below it.

```text
CreateContainerConfigError
```

A referenced Secret, ConfigMap or key does not exist.

```text
Running, READY 0/1
```

The readiness probe fails, so the pod is out of its Service and gets no traffic.

```text
Evicted
```

The node ran short of memory or disk. `kubectl describe node` shows its pressure conditions.

```text
Terminating, forever
```

A finalizer is waiting, or the node is gone. Check `.metadata.finalizers`. Force-delete only when you know the node is dead: a StatefulSet can end up with two pods.

```text
Ingress returns 503 or 404
```

503: the Service has no ready endpoints. 404: no host or path rule matches, or the wrong `ingressClassName`.

```text
external DNS slow in pods
```

`ndots:5` makes every external name try each search domain first. Use a trailing dot (`api.example.com.`) or lower ndots in `dnsConfig`.

## PostgreSQL

Most incidents are a lock, a long transaction, connection exhaustion or a full disk. `pg_stat_activity` shows the first three.

### Connect

```sh
pg_isready -h HOST -p 5432
```

Exit 0: accepting. 1: rejecting, usually still starting up. 2: no response.

```sh
psql "host=HOST dbname=app user=app sslmode=require"
```

Then `\conninfo`, `\l`, `\dt+`, `\d+ TABLE`, `\x auto`, `\timing on`.

```sql
SHOW hba_file;
SELECT pg_reload_conf();
```

Where the auth rules live. A reload applies `pg_hba.conf` and most settings; `listen_addresses`, `max_connections` and `shared_buffers` need a restart.

```sh
journalctl -u 'postgresql*' -n 100
```

The server log. On Debian and Ubuntu it is also under `/var/log/postgresql/`.

### What is running

```sql
SELECT pid, usename, state, wait_event_type, wait_event,
       now() - xact_start AS xact_age, left(query, 80) AS query
FROM pg_stat_activity
WHERE state <> 'idle'
ORDER BY xact_age DESC NULLS LAST;
```

Everything not idle, oldest transaction first. "idle in transaction" with a large age holds locks and stops vacuum; set `idle_in_transaction_session_timeout`.

```sql
SELECT pid, pg_blocking_pids(pid) AS blocked_by,
       wait_event_type, left(query, 60) AS query
FROM pg_stat_activity
WHERE cardinality(pg_blocking_pids(pid)) > 0;
```

Who waits on whom. Follow `blocked_by` to the root blocker, usually a long or idle-in-transaction session.

```sql
SELECT pg_cancel_backend(PID);
```

Cancels the running query. The session stays.

```sql
SELECT pg_terminate_backend(PID);
```

Ends the session and rolls back its transaction.

```sql
SELECT state, count(*) FROM pg_stat_activity GROUP BY 1;
SHOW max_connections;
```

Connections by state, against the limit.

```sql
SET lock_timeout = '5s';
```

Run it before `ALTER TABLE` in a migration. DDL waiting for a lock queues every later query behind it; this makes it give up instead.

### Slow queries

```sql
SELECT calls, round(total_exec_time) AS total_ms,
       round(mean_exec_time::numeric, 1) AS mean_ms, left(query, 80) AS query
FROM pg_stat_statements
ORDER BY total_exec_time DESC LIMIT 10;
```

The queries that cost the most time in total. Needs `pg_stat_statements` in `shared_preload_libraries`, then `CREATE EXTENSION`.

```sql
EXPLAIN (ANALYZE, BUFFERS) SELECT ...;
```

Runs the query for real. Look for estimated rows far from actual (run `ANALYZE` on the table), a Seq Scan on a big table with a selective filter (missing index), and "external merge Disk" (`work_mem` too small).

```sql
BEGIN; SET LOCAL lock_timeout = '2s'; EXPLAIN ANALYZE UPDATE ...; ROLLBACK;
```

Analyzes a write and undoes it, but it runs for real: until ROLLBACK it holds its row locks, fires triggers and writes WAL, and sequence values and writes through foreign tables or dblink stay. The lock timeout keeps it from queueing behind others; on a busy table, run it on a copy (a replica cannot run an UPDATE).

```sql
SELECT relname, seq_scan, idx_scan, n_live_tup
FROM pg_stat_user_tables
ORDER BY seq_scan DESC LIMIT 10;
```

Big tables read by sequential scans are index candidates.

### Space and replication

```sql
SELECT relname, pg_size_pretty(pg_total_relation_size(relid)) AS size,
       n_dead_tup, last_autovacuum
FROM pg_stat_user_tables
ORDER BY pg_total_relation_size(relid) DESC LIMIT 10;
```

Biggest tables and their dead rows. Many dead rows and an old `last_autovacuum`: vacuum cannot keep up, or an old transaction blocks it.

```sql
SELECT slot_name, active,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained
FROM pg_replication_slots;
```

An inactive slot keeps WAL forever and fills the disk. If its consumer is gone: `SELECT pg_drop_replication_slot('NAME');`

```sql
SELECT client_addr, state, write_lag, replay_lag FROM pg_stat_replication;
```

On the primary: each replica and its lag.

```sql
SELECT now() - pg_last_xact_replay_timestamp();
```

On a replica: the age of the last replayed change. It also grows when the primary is simply idle.

```sql
SELECT datname, age(datfrozenxid) FROM pg_database ORDER BY 2 DESC;
```

Transaction ID age. Past a billion and climbing, vacuum is losing; near two billion PostgreSQL stops accepting writes.

### PostgreSQL errors

```text
FATAL: sorry, too many clients already
```

`max_connections` reached. Count app instances times pool size. Put PgBouncer in front rather than raising the limit: each connection is a process with its own memory.

```text
FATAL: remaining connection slots are reserved
```

The same limit; only the reserved superuser slots remain.

```text
FATAL: no pg_hba.conf entry for host
```

No rule matches this host, user, database and SSL mode. Rules match top to bottom and the first match wins. Add one, then `pg_reload_conf()`.

```text
FATAL: password authentication failed for user
```

A wrong password, or the stored hash is md5 while `pg_hba.conf` asks for scram-sha-256: set `password_encryption`, then reset the password.

```text
connection to server at "HOST", port 5432 failed: Connection refused
```

The server is down, or `listen_addresses` is 'localhost'. Changing it needs a restart.

```text
ERROR: deadlock detected
```

Two transactions locked the same rows in opposite orders. Lock in one consistent order and retry the loser; the server log has both queries.

```text
canceling statement due to statement timeout
```

`statement_timeout` hit: a slow query, or one stuck behind a lock (check `pg_blocking_pids`).

```text
canceling statement due to conflict with recovery
```

On a replica: vacuum on the primary removed rows your query still needed. Turn on `hot_standby_feedback` or raise `max_standby_streaming_delay`.

```text
server closed the connection unexpectedly
```

The backend died (look for "terminated by signal 9" in the server log and the OOM killer in `dmesg`), or a firewall or load balancer dropped an idle connection. Enable TCP keepalives and cap the pool's connection lifetime.

```text
duplicate key value violates unique constraint "..._pkey"
```

Right after a restore: the sequence is behind the data. `SELECT setval(pg_get_serial_sequence('T', 'id'), max(id)) FROM T;`

```text
could not extend file: No space left on device
```

Disk full. Check `pg_wal` and replication slots before deleting anything, and never delete WAL files by hand.

```text
the database system is starting up
```

Crash recovery is replaying WAL. Wait and watch the server log.

## MySQL and MariaDB

The processlist and InnoDB's status report cover locks, long transactions and deadlocks. Commands are for MySQL 8.0.

```sh
mysqladmin -h HOST ping
```

"mysqld is alive" when the server answers.

```sql
SHOW FULL PROCESSLIST;
```

Every connection, what it runs and for how long. Many Sleep rows: a pool holding idle connections.

```sql
SELECT id, user, host, db, command, time, state, left(info, 80) AS query
FROM information_schema.processlist
WHERE command <> 'Sleep' ORDER BY time DESC;
```

The same without the sleepers, longest first.

```sql
KILL QUERY ID;
```

Stops the statement. `KILL ID;` drops the whole connection.

```sql
SELECT * FROM sys.innodb_lock_waits\G
```

Who blocks whom, with a ready-made kill statement in `sql_kill_blocking_query`.

```sql
SHOW ENGINE INNODB STATUS\G
```

Read LATEST DETECTED DEADLOCK and TRANSACTIONS: lock waits, and transactions open for a long time.

```sql
SHOW GLOBAL STATUS LIKE 'Threads_connected';
SHOW VARIABLES LIKE 'max_connections';
```

Connections against the limit.

```sql
SET GLOBAL slow_query_log = ON;
SET GLOBAL long_query_time = 1;
```

Logs statements over 1 s; new connections pick up the threshold. `SET GLOBAL` is lost at the next restart; `SET PERSIST` (MySQL 8) keeps it. Summarize with `mysqldumpslow -s t` or pt-query-digest.

```sql
EXPLAIN ANALYZE SELECT ...;
```

Runs it and shows the actual time per step (8.0.18+). In plain `EXPLAIN`, type ALL is a full table scan.

```sql
SHOW REPLICA STATUS\G
```

Replica_IO_Running and Replica_SQL_Running must both say Yes. Then read Seconds_Behind_Source and Last_SQL_Error. Before 8.0.22: `SHOW SLAVE STATUS`.

```sql
SELECT table_schema, table_name,
       round((data_length + index_length) / 1048576) AS mb
FROM information_schema.tables ORDER BY mb DESC LIMIT 10;
```

Largest tables. InnoDB's numbers are estimates.

```sql
SELECT user, host, plugin FROM mysql.user;
```

Accounts and the hosts they may connect from.

### MySQL errors

```text
ERROR 1040: Too many connections
```

`max_connections` reached. Look for Sleep connections from a leaking pool. One extra slot stays free for an admin with CONNECTION_ADMIN.

```text
ERROR 1045: Access denied for user 'app'@'10.0.0.7'
```

The account exists for another host: 'app'@'localhost' and 'app'@'%' are different users. localhost means the Unix socket; use 127.0.0.1 to force TCP.

```text
ERROR 2002: Can't connect to local MySQL server through socket
```

The server is down, or the client looks for the socket at another path.

```text
ERROR 2003: Can't connect to MySQL server on 'HOST' (111)
```

111 is refused: the server is down or `bind-address` is 127.0.0.1. 110 is a timeout: a firewall.

```text
ERROR 1205: Lock wait timeout exceeded
```

Another transaction holds the row, often one left open and idle. Only the statement rolls back, not the transaction, unless `innodb_rollback_on_timeout` is on.

```text
ERROR 1213: Deadlock found when trying to get lock
```

InnoDB rolled back one transaction; retry it. The details are under LATEST DETECTED DEADLOCK.

```text
ERROR 2006: MySQL server has gone away
```

`wait_timeout` closed an idle connection (validate or recycle pooled connections sooner), a packet exceeded `max_allowed_packet`, or the server restarted (`SHOW GLOBAL STATUS LIKE 'Uptime'`). 2013 Lost connection has the same causes.

```text
Host 'HOST' is blocked because of many connection errors
```

Often a load balancer health check opening TCP without speaking MySQL. Run `TRUNCATE performance_schema.host_cache` (`FLUSH HOSTS` before 8.0.23), raise `max_connect_errors`, fix the check.

```text
ERROR 1114: The table is full
```

Usually disk or tmpdir space, not a row limit.

## Redis

One command thread serves everyone, so a single slow command stalls every client.

```sh
read -rs REDISCLI_AUTH && export REDISCLI_AUTH && redis-cli -h HOST ping
```

PONG means up. `read -s` takes the password without echo and keeps it out of shell history; the variable keeps it out of `ps`. With `-a` every user on the host can see it.

```sh
redis-cli INFO memory
```

`used_memory_human` against `maxmemory_human`. `mem_fragmentation_ratio` above 1.5 is fragmentation.

```sh
redis-cli INFO clients
```

`connected_clients` and `blocked_clients`. `CLIENT LIST` shows each one.

```sh
redis-cli SLOWLOG GET 10
```

The slowest recent commands with their arguments.

```sh
redis-cli --bigkeys -i 0.1
```

The biggest key per type. It uses SCAN, so it does not block like KEYS, but it walks the whole keyspace: `-i 0.1` pauses between batches, and on a busy primary it belongs on a replica. `--memkeys` gives sizes in bytes.

```sh
redis-cli --latency
```

Round-trip latency, live. Spikes with a quiet SLOWLOG point to the fork for persistence, or the network.

```sh
redis-cli INFO persistence
```

`rdb_last_bgsave_status` and `aof_last_write_status` must read ok.

```sh
redis-cli INFO replication
```

The role, connected replicas, and `master_link_status` on a replica.

```text
KEYS *
```

Blocks the command thread for the whole keyspace. Use `SCAN 0 MATCH 'user:*' COUNT 1000` instead.

```text
MONITOR
```

Streams every command and costs a large share of throughput. Seconds only, in production.

### Redis errors

```text
OOM command not allowed when used memory > 'maxmemory'
```

Full, with `maxmemory-policy` noeviction. A cache wants allkeys-lru; a datastore needs more memory.

```text
MISCONF Redis is configured to save RDB snapshots, but it's currently unable to persist to disk
```

The background save failed: disk full, permissions, or the fork was refused memory (set `vm.overcommit_memory = 1`). Writes are refused until a save succeeds.

```text
LOADING Redis is loading the dataset in memory
```

It just restarted. Wait.

```text
READONLY You can't write against a read only replica
```

You reached a replica. After a failover the client still points at the old primary; use a Sentinel- or Cluster-aware client.

```text
NOAUTH Authentication required
```

No credentials sent. WRONGPASS: a wrong password, or an ACL user without access.
