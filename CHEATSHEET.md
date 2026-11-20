# Server Triage Sheet

Commands and error meanings for a broken host, service or database. Each entry is a command or an error message, then what it tells you and where to look next. Placeholders in capitals (HOST, PID, POD, SVC, APP) are yours to fill; the app fills them in from its Setup panel.

A tag after a block's language says more: `changes` changes state, `danger` can lose data, `deb` and `rhel` name the one distribution it is for, and a version such as `pg16+` is the oldest one it runs on.

Written for Linux with systemd (Ubuntu 22.04 and later, RHEL 8 and 9), OpenSSL 3, Kubernetes 1.30 and later, PostgreSQL 14 to 18, MySQL 8.0 and 8.4, MariaDB 10.11 and 11.4, SQL Server 2019 and 2022, SQLite 3.37 and later, Redis 7 and Valkey 8, MongoDB 7 and 8, Kafka 3.7 and later (KRaft), RabbitMQ 4, Elasticsearch 8 and OpenSearch 2, JDK 17 and later, Node.js 20 and later, Python 3.9 and later, Go 1.22 and later, and the current AWS, Google Cloud and Azure CLIs. A tag marks a command that needs a newer version. Searchable, click-to-copy and offline: [the app](https://makavli.github.io/server-triage/).

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

### Network and sockets

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
Network is unreachable
```

Your own routing table has no route to that address, often no default gateway after a link or DHCP failure. Different from "No route to host": no packet left. **Check** `ip route` and `ip -br addr`.

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

Another process holds the port: `sudo ss -tlnp 'sport = :PORT'`. A server that restarts fast also needs SO_REUSEADDR.

```text
small requests work, big ones hang
```

An MTU black hole: a tunnel, VPN or overlay lowers the MTU and the ICMP "fragmentation needed" reply is blocked. **Check** with the `ping -M do` test under DNS, ports and packets.

### Limits and resources

```text
Too many open files
```

The process hit its file descriptor limit: a leak or a low limit. **Check** `ls /proc/PID/fd | wc -l` against `/proc/PID/limits`; raise `LimitNOFILE=` in the unit.

```text
No space left on device
```

Out of blocks or out of inodes (`df -h`, `df -i`). From a file watcher it means `fs.inotify.max_user_watches` is used up, not the disk.

```text
Error: ENOSPC: System limit for number of file watchers reached
Failed to allocate directory watch: Too many open files
```

Not a full disk: the inotify limits. The first is `fs.inotify.max_user_watches`, the second `fs.inotify.max_user_instances`, both counted per user. **Check** them with `sysctl fs.inotify`; many containers or editors on one host exhaust the instances.

```sh changes
sudo sysctl -w fs.inotify.max_user_watches=524288
```

Raises the watch limit until reboot, at a few hundred bytes of kernel memory per watch. To keep it, write the same key into a file under `/etc/sysctl.d/` and run `sudo sysctl --system`.

```text
Cannot allocate memory
```

ENOMEM. A fork or mmap was refused: a cgroup or `ulimit -v` limit, strict overcommit (`vm.overcommit_memory=2`, compare **CommitLimit** and **Committed_AS** in `/proc/meminfo`), or too many mappings. Elasticsearch and similar tools need `vm.max_map_count` raised from its default of 65530.

```text
Resource temporarily unavailable
```

EAGAIN. On a non-blocking socket read or accept it is normal flow control, not a fault. From `fork` or `pthread_create` it is the process or thread limit (see the fork entry). `flock -n` exits 1 silently when another process holds the lock (`lslocks`); a program that hits a held lock may print this message.

```text
fork: Resource temporarily unavailable
```

Process or thread limit: `ulimit -u`, the cgroup's `pids.max`, `kernel.pid_max`. Often a thread leak.

### Permissions and security modules

```text
Permission denied
```

File mode or owner, a parent directory without x, SELinux or AppArmor, or a port under 1024 without CAP_NET_BIND_SERVICE. **Check** `namei -l /path` and `ausearch -m avc -ts recent`.

```text
Operation not permitted
```

A missing capability (common in containers), a seccomp filter, or an immutable file (`lsattr`). Being root does not bypass these.

```sh
getenforce
ls -Z FILE
```

**Enforcing** means SELinux blocks what the policy does not allow, even for root; **Permissive** only logs. Compare the type in the `ls -Z` output with a sibling file that works: a file moved in from elsewhere keeps the wrong type.

```sh rhel
sudo ausearch -m avc,user_avc -ts recent | audit2why
```

Each denial with the reason: often a missing boolean (for example `httpd_can_network_connect`) or a wrong file type. No output means no denial was logged in the last 10 minutes: use `-ts today` for older ones. dontaudit rules hide some denials: `sudo semodule -DB` logs them, `sudo semodule -B` hides them again. Needs the `policycoreutils-python-utils` package.

```sh changes rhel
sudo restorecon -Rv FILE
```

Resets the labels under FILE to what policy says, and prints each change. Fixes files copied or moved into place. For a custom path, add a rule with `semanage fcontext` first, or the next relabel undoes it.

```sh
sudo journalctl -k --since today | grep 'apparmor="DENIED"'
```

AppArmor denials, with the **profile**, **operation**, **name** (the path) and **comm**. A profile in complain mode only logs. `sudo aa-status` lists the loaded profiles and their modes.

### Crashes and program loading

```text
Killed
```

SIGKILL, exit 137: often the OOM killer or a cgroup memory limit; **check** `sudo dmesg -T | grep -i 'killed process'`. If the kernel log is clean, someone sent `kill -9`, or systemd killed it when it outlived `TimeoutStopSec=` (`journalctl -u UNIT`).

```text
Segmentation fault
```

SIGSEGV, exit 139: the program touched memory it does not own. The kernel logs `segfault at ... in libname.so`; the name after "in" points at the crashing library, an address near 0 at a null pointer. **Check** `sudo dmesg -T | grep segfault` and `coredumpctl info PID`.

```text
Aborted (core dumped)
Illegal instruction (core dumped)
Bus error (core dumped)
```

Exit 134, 132 and 135. Aborted: the program called abort(), often glibc catching a double free or a failed assert. Illegal instruction: a binary built for CPU features this host lacks (AVX-512, or a VM with a masked CPU model). Bus error: a mapped file shrank or its disk filled.

```text
bash: ./app: cannot execute binary file: Exec format error
```

The binary is for another architecture (arm64 on x86_64 is the usual one, with images). Started by systemd or another program, a script with no shebang line fails with the same Exec format error. **Check** `file FILE` against `uname -m`; a foreign image needs qemu binfmt support.

```text
error while loading shared libraries: libssl.so.1.1: cannot open shared object file: No such file or directory
/lib64/libc.so.6: version `GLIBC_2.34' not found (required by ./app)
```

The first: a library is missing; **check** `ldd FILE | grep 'not found'` and `ldconfig -p`. The second: the binary was built on a newer distribution than it runs on. Build on the oldest target or ship a matching base image. `ldd` runs the program's loader: use it only on binaries you trust.

```text
/usr/bin/env: 'bash\r': No such file or directory
```

The script has Windows line endings. **Fix** with `sed -i 's/\r$//' script.sh` and prevent it with `git config core.autocrlf input`.

```text
bash: /usr/bin/ls: Argument list too long
```

E2BIG. A glob expanded past `getconf ARG_MAX` (about 2 MiB here, a quarter of the stack limit). The shell failed, not the command. Pass the names through `find ... -print0 | xargs -0`, or `find ... -exec ... +`.

```text
cp: cannot create regular file '/usr/local/bin/app': Text file busy
```

ETXTBSY. You cannot write over a binary that is running. **Fix** a deploy by copying to a new name and `mv`-ing it over: the rename is allowed and atomic. `fuser -v FILE` lists who runs it.

### Filesystem errors

```text
Read-only file system
```

The kernel remounted the filesystem after IO errors (see `dmesg`), or a container runs with a read-only root.

```text
Input/output error
```

EIO. The device failed the read or write: a dying disk, a cable, a volume or iSCSI path that vanished, or a hung FUSE mount. **Check** `sudo dmesg -T | grep -iE 'i/o error|blk_update_request|nvme|ata[0-9]'`, then SMART (see Storage and filesystems).

```text
Stale file handle
```

ESTALE, almost always NFS: the file, directory or whole export was deleted or recreated on the server, so the client's handle points at nothing. Remount, and restart anything with its working directory there. Give exports a fixed `fsid=` so a rebuild does not change handles.

```text
Transport endpoint is not connected
```

ENOTCONN. On a FUSE mount (sshfs, rclone, s3fs, GlusterFS) the userspace daemon died and the mount is orphaned. Unmount it with `fusermount -uz MNT` or `umount -l MNT`, then mount it again. **Check** the daemon's log for why it exited.

```text
Structure needs cleaning
```

EUCLEAN: XFS, and ext4 too, found corrupt metadata and refuses to use it. Unmount, snapshot or image the device if the data matters, then `xfs_repair` or `e2fsck`. See Storage and filesystems.

### Kernel log lines

```text
Out of memory: Killed process 4242 (java) total-vm:12582912kB, anon-rss:8388608kB, file-rss:0kB, shmem-rss:0kB, UID:998 pgtables:16384kB oom_score_adj:0
Memory cgroup out of memory: Killed process 4242 (java) total-vm:12582912kB, anon-rss:1048576kB, file-rss:0kB, shmem-rss:0kB, UID:998 pgtables:4096kB oom_score_adj:0
```

The first: the whole host ran out of memory. The second: a cgroup hit its own limit while the host had room. **anon-rss** is the memory freed. The `oom-kill:` line before names the cause: `constraint=CONSTRAINT_MEMCG` with `oom_memcg=` is a cgroup limit, `CONSTRAINT_NONE` is the host.

```text
INFO: task jbd2/sda1-8:312 blocked for more than 120 seconds.
```

A task sat in uninterruptible sleep (state D) past `kernel.hung_task_timeout_secs`: stuck disk IO, a dead NFS server, a lock never released. The stack follows in `dmesg`. **Check** `ps -eo stat,pid,wchan:20,comm | awk '$1 ~ /^D/'`.

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

```sh changes
systemctl reset-failed APP
```

Clears "start request repeated too quickly" (StartLimitBurst hit) once you have fixed the cause.

```sh
systemd-analyze verify /etc/systemd/system/APP.service
```

Reads the unit without starting it and prints unknown keys, missing executables and bad dependencies, with line numbers. Run it after editing, before `systemctl daemon-reload`.

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
exit 134
```

128 + 6, SIGABRT: the program aborted itself, often a failed assert or glibc catching heap corruption. Look for a core file: `coredumpctl list`.

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

```sh systemd243+
systemd-analyze exit-status 226
```

Names a `status=` code and its class. 226 is NAMESPACE: a sandbox option (`ReadWritePaths=`, `BindPaths=`, `PrivateTmp=`) names a path that does not exist or cannot be mounted. 228 is SECCOMP, 238 STATE_DIRECTORY. Without arguments it lists them all.

### systemd timers and cron

```sh
systemctl list-timers --all
```

**NEXT** and **LEFT** are the next run, **LAST** and **PASSED** the previous one, **ACTIVATES** the service that does the work. A `-` under NEXT means no future run: the timer is inactive or its calendar never matches. The job's output is in `journalctl -u APP.service`.

```sh
systemctl show APP.timer -p NextElapseUSecRealtime,LastTriggerUSec,Persistent,RandomizedDelayUSec,AccuracyUSec
```

When it fires next and when it last did. **Persistent=no** means a run missed while the host was off is skipped, not made up at boot. **RandomizedDelayUSec** and **AccuracyUSec** (default 1 minute) move a run later than the clock time.

```sh
systemd-analyze calendar 'Mon..Fri *-*-* 02:30'
```

Checks an `OnCalendar=` expression and prints its normalised form and the next run. A typo is rejected here, not at 2 a.m. Timestamps are in the host's time zone unless the expression ends in `UTC`.

```sh
sudo cat /etc/crontab /etc/cron.d/*
```

System crontabs carry a sixth field, the user (`* * * * * root command`); a user's `crontab -e` has none, and a missing field is the commonest silent failure. cron's PATH is short, and a bare `%` ends the command: write `\%`. Debian cron ignores `/etc/cron.d` files with a dot in the name. The output may show passwords in command lines.

```sh deb
run-parts --test /etc/cron.daily
```

Lists the scripts `cron.daily` would run. A script that is not executable, or whose name has a dot such as `backup.sh`, is skipped without a word.

```sh deb
sudo journalctl -u cron --since today
```

One line per start, `CRON[PID]: (user) CMD (command)`. A job that starts here but does nothing failed inside its own command: cron does not log its exit code.

```sh rhel
sudo journalctl -u crond --since today
```

The cronie log: starts, and errors such as a bad crontab line. The job's own output goes by mail to the user, or to nowhere when no mail agent is installed.

```text
(CRON) info (No MTA installed, discarding output)
```

The job wrote output and cron had nowhere to send it, so it was dropped, possibly with the error that explains the failure. Redirect it in the crontab line with `>> /var/log/job.log 2>&1`.

### journald

```sh
journalctl --disk-usage
```

What the journal takes on disk. Defaults cap it at 10% of the filesystem, 4 GiB at most, and keep 15% free (`SystemMaxUse=`, `SystemKeepFree=`). A volume that fills up with `/var/log/journal` is the sign.

```sh danger
sudo journalctl --vacuum-size=500M
```

Deletes the oldest archived journal files until the total is under 500 MiB. They cannot be restored. `--vacuum-time=2weeks` deletes by age. The active file is not touched; run `sudo journalctl --rotate` first to archive it.

```sh
sudo journalctl --verify
```

Checks every journal file and prints PASS or FAIL per file. A FAIL means a corrupt file, usually after a crash or a full disk: move it aside and `journalctl` reads the rest. The system keeps writing to a new file.

```sh
systemd-analyze cat-config systemd/journald.conf
```

The effective `journald.conf` with every drop-in under `journald.conf.d`, in load order. Set `SystemMaxUse=`, `Storage=` and `RateLimitBurst=` in a drop-in, never in the packaged file.

```sh changes
sudo mkdir -p /var/log/journal
sudo systemd-tmpfiles --create --prefix /var/log/journal
sudo systemctl restart systemd-journald
```

Makes the journal persistent where it lives in `/run` and is lost at reboot. With `Storage=auto` (the default) journald writes to `/var/log/journal` only when that directory exists. **Check** with `journalctl --list-boots`: before this, one row.

```sh
journalctl --list-boots
```

One row per boot kept. Only the current boot means the journal is not persistent, so `journalctl -b -1` after a crash shows nothing. Rows missing in the middle are vacuumed or rotated away.

```text
systemd-journald[412]: Suppressed 5230 messages from APP.service
```

The service hit the journal's rate limit (`RateLimitIntervalSec=` and `RateLimitBurst=`) and lines were dropped, probably the ones you want. Fix the noisy service first. Raising `RateLimitBurst=` for the whole journal hides it, but also hides the next flood.

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

### Time and clock

```sh
timedatectl
```

Clock and NTP sync. **System clock synchronized: yes** is the line that matters. Skew breaks TLS validity, JWT expiry, Kerberos and distributed locks. **RTC in local TZ: yes** is a Windows dual-boot habit that jumps the clock by the offset.

```sh systemd239+
timedatectl timesync-status
```

For hosts that sync with `systemd-timesyncd` only: the **Server**, the **Offset** and the poll interval. It prints an error when chrony or another daemon does the sync, so ask that daemon instead.

```sh
chronyc tracking
```

**System time** is how far the clock is from NTP time, **Last offset** the latest correction. **Leap status: Not synchronised** or **Stratum** 0 means no usable source. Offset above a few milliseconds on a LAN host deserves a look. The unit is `chrony` on Debian and `chronyd` on RHEL.

```sh
chronyc sources -v
```

One row per server. `^*` is the source in use, `^+` a usable one, `^?` unreachable. **Reach** 377 is eight good polls in a row, 0 none: then check UDP port 123 to the server and its DNS name.

```sh changes
sudo chronyc makestep
```

Steps the clock to NTP time now, instead of the slow slew chrony prefers. A jump backwards can upset databases, job schedulers and anything that assumes time only moves forward. Prefer to let a small offset slew away.

```text
verify error:num=9:certificate is not yet valid
verify error:num=10:certificate has expired
```

TLS with a wrong clock: a fresh VM, a reset RTC or a paused guest that wakes in the past fails every handshake. **Check** `date -u` against `openssl x509 -noout -dates`: if the date is wrong on the host, fix the clock before touching the certificate.

```text
Clock skew too great
RequestTimeTooSkewed: The difference between the request time and the current time is too large.
```

Signed requests carry a timestamp. Kerberos tolerates 5 minutes by default (`clockskew` in `krb5.conf`), S3 15 minutes. Compare `date -u` with `chronyc tracking` on both ends.

## CPU, memory, disk, files

Where the machine's limits are, and which process is pressing on them.

### Memory

```sh
ps aux --sort=-%mem | head
```

Top memory users by RSS. Use `--sort=-%cpu` for CPU.

```sh
grep -E 'MemAvailable|SwapFree|^Dirty|^Slab|SUnreclaim|AnonPages|Shmem:' /proc/meminfo
```

Where the memory went. Small **MemAvailable** with large **Slab** and **SUnreclaim** is kernel memory, not a process. Large **Dirty** means writeback is behind. **Shmem** counts tmpfs, which `ps` never shows.

```sh
sysctl vm.overcommit_memory vm.swappiness vm.max_map_count
grep -E 'CommitLimit|Committed_AS' /proc/meminfo
```

Overcommit mode 0 guesses, 1 never refuses, 2 enforces **CommitLimit**. With mode 2, **Committed_AS** above the limit is why `fork` and `malloc` fail while `free` shows plenty. **max_map_count** caps mappings per process.

```sh
grep -E 'VmRSS|VmSwap|Threads' /proc/PID/status
```

A process's resident memory, how much of it is in swap, and its thread count. High **VmSwap** on a hot process means it is paging.

### Pressure and cgroups

```sh kernel4.20+
cat /proc/pressure/cpu /proc/pressure/memory /proc/pressure/io
```

Pressure stall information: the share of time tasks waited. **some** is at least one task stalled, **full** all of them. **avg10** above about 10 for memory or io is a host in trouble, at any utilisation. CPU has no meaningful **full** on older kernels. Needs `psi=1` on RHEL 8.

```sh
stat -fc %T /sys/fs/cgroup
```

`cgroup2fs` means cgroup v2: one tree, and the files below exist. `tmpfs` means v1, with a directory per controller and different file names (`memory.limit_in_bytes`).

```sh
cat /proc/PID/cgroup
```

The cgroup a process lives in, for example `0::/system.slice/APP.service`. On v2 the limits and counters are in `/sys/fs/cgroup` plus that path.

```sh
systemd-cgtop
```

CPU, memory and IO per cgroup, so per service or per container.

```sh
cd /sys/fs/cgroup/system.slice/APP.service
cat memory.current memory.max memory.events
```

Use now and the limit (`max` is none). **memory.events** counts **high** and **max** hits and **oom_kill**: a non-zero **oom_kill** means this service was killed for hitting its limit, whatever the host's free memory. Counters never reset.

```sh
systemctl show APP -p MemoryCurrent,MemoryMax,MemoryHigh,TasksCurrent,TasksMax
```

The same limits, as systemd sets them. `infinity` is no limit and `[not set]` means accounting is off. **TasksMax** is the cgroup `pids.max` behind "Resource temporarily unavailable".

```sh
cat /sys/fs/cgroup/system.slice/APP.service/cpu.stat
```

**nr_throttled** and **throttled_usec** rising mean the CPU quota (`CPUQuota=`, a Kubernetes CPU limit) is capping the service: latency with a mostly idle CPU. Compare **nr_throttled** with **nr_periods**.

### The OOM killer

```sh
sudo dmesg -T | grep -iE 'killed process|out of memory'
```

Which process the OOM killer chose, and its RSS at that moment. If the kernel log is empty, systemd-oomd may have acted: `journalctl -u systemd-oomd`.

```sh
for p in /proc/[0-9]*; do echo "$(cat $p/oom_score 2>/dev/null) $(cat $p/oom_score_adj 2>/dev/null) ${p#/proc/} $(cat $p/comm 2>/dev/null)"; done | sort -rn | head
```

Columns: **oom_score**, **oom_score_adj**, PID, name. The kernel kills the highest score: mostly the share of memory a process uses, shifted by the adjustment (-1000 to 1000). A big database tops the list, so it is usually the victim.

```sh changes
echo -500 | sudo tee /proc/PID/oom_score_adj
```

Makes the OOM killer less likely to pick this process, until it restarts; -1000 exempts it and a different process dies instead. Set it for good with `OOMScoreAdjust=` in the unit. It treats a symptom: fix the memory use.

### CPU and stuck processes

```sh
top -H -b -n1 -p PID | head -15
```

One row per thread. One thread at 100% is a single-threaded hot loop; many threads in D or S with low CPU point at waiting.

```sh
ps -eo stat,pid,wchan:20,comm | awk '$1 ~ /^D/'
```

Tasks in uninterruptible sleep, with the kernel function they wait in. A few for a moment are normal; the same ones for minutes explain a high load average with idle CPUs. **wchan** such as `nfs_` or `io_schedule` names the culprit.

```sh
ps -eo stat,ppid,pid,comm | awk '$1 ~ /^Z/'
```

Zombies: finished but not reaped. They hold only a process slot, but thousands exhaust `pid_max`. Fix or restart the parent (**PPID**); killing a zombie does nothing.

```sh changes
sudo timeout 10 strace -f -tt -p PID -e trace=network,file
```

What a stuck or slow process is doing, syscall by syscall. It slows the target a lot: seconds, not minutes, in production. Stop it with Ctrl-C or `timeout`, never `kill -9`: a strace killed hard can leave the target stopped (`kill -CONT PID`).

```sh changes
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

Hot functions live, kernel and user space. Needs root, or a low `kernel.perf_event_paranoid`. Perf comes with the `linux-tools` or `perf` package and is often not installed.

```sh changes
sudo perf record -F 99 -g -p PID -- sleep 30
sudo perf report --stdio | head -40
```

Samples the stacks 99 times a second for 30 seconds and shows the heaviest call paths. It writes `perf.data` in the current directory: remove it afterwards. Without frame pointers the stacks are shallow.

```sh
sudo bpftrace -e 'tracepoint:syscalls:sys_enter_openat { @[comm] = count(); } interval:s:10 { exit(); }'
```

Counts file opens by command for 10 seconds and prints the table. Cheap enough for production. Only where bpftrace is installed and the kernel allows eBPF.

### Disk space

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

Biggest directories; `-x` stays on one filesystem. As root so no directory is skipped, at idle I/O priority so it does not starve the disk. That holds only where the disk's scheduler honours priorities (`cat /sys/block/DISK/queue/scheduler`): `bfq` does, `none`, common on NVMe, does not. Repeat one level down.

```sh
sudo ionice -c3 find / -xdev -type f -size +500M -printf '%s %p\n' 2>/dev/null | sort -rn | head
```

The biggest single files on the root filesystem, in bytes. Repeat with another mount point for other filesystems. Add `-mtime -1` to see only what grew today. It walks the whole tree, so it runs at idle I/O priority.

```sh
for d in /var/*/; do echo "$(sudo find "$d" -xdev 2>/dev/null | wc -l) $d"; done | sort -rn | head
```

Entries per directory: where the inodes went when `df -i` says full. Change `/var` to the filesystem concerned. It walks the tree, so it takes a while on a big one.

```sh
sudo lsof +L1
```

Deleted files still held open. When `df` says full and `du` cannot find it, it is usually these; otherwise files hidden under a mount point (`mount --bind / /mnt` and run `du` on `/mnt`). `lsof` can hang on a dead NFS mount. Restart the holder. For a log only, truncate it with `sudo truncate -s 0 /proc/PID/fd/N`, after copying it to another filesystem if you need it. Never truncate a live database file or WAL: the process still uses it. A writer that does not append keeps its offset, so the file comes back sparse.

```sh
sudo find /proc/[0-9]*/fd -lname '*(deleted)' -printf '%p -> %l\n' 2>/dev/null | head
```

The same without lsof: the path shows the **PID** and the descriptor number. Processes that share a descriptor, such as fork children, each list it.

### Files and descriptors

```sh
ls /proc/PID/fd | wc -l
```

Open descriptors. Compare with `grep 'open files' /proc/PID/limits`; a count that keeps climbing is a leak.

```sh
for p in /proc/[0-9]*; do echo "$(ls $p/fd 2>/dev/null | wc -l) ${p#/proc/} $(cat $p/comm 2>/dev/null)"; done | sort -rn | head
```

Which processes hold the most descriptors (count, PID, name). Run as root to see all of them. Then `ls -l /proc/PID/fd | awk '{print $NF}' | sort | uniq -c | sort -rn | head` for what they hold.

```sh
systemctl show APP -p LimitNOFILE,LimitNPROC,TasksMax
```

The limits a unit's processes really get. A shell's `ulimit -n` says nothing about a service: systemd applies its own, and `LimitNOFILE=` in the unit is where to raise it.

```sh changes
sudo prlimit --pid PID --nofile=65536:65536
```

Raises the open-files limit of a running process, with no restart, until it exits. Buys time for a leak; the real fix is `LimitNOFILE=` in the unit and the leak. Check with `grep 'open files' /proc/PID/limits`.

## Storage and filesystems

Disks fail slowly and filesystems fail loudly. Read the kernel log and the health data first, repair last, and only on an unmounted device you have a copy of.

### Block devices

```sh
lsblk -f
```

The tree of disks, partitions, LVM and RAID, with **FSTYPE**, **LABEL**, **UUID** and **MOUNTPOINTS**. A disk or partition with no FSTYPE has no filesystem; `LVM2_member` or `linux_raid_member` means it belongs to a volume group or an array, not a plain mount.

```sh
sudo blkid
```

The UUID and type of every device. Use the UUID in `/etc/fstab`, not `/dev/sdb1`: device names change between boots. Two devices with the same UUID are a clone or a snapshot, unless they are members of one RAID array or paths to one multipath disk.

```sh
sudo dmesg -T | grep -iE 'i/o error|blk_update_request|buffer i/o|medium error|nvme.*(timeout|reset)|ata[0-9.]+: (exception|failed)'
```

Disk and controller trouble in the kernel log. `blk_update_request: I/O error, dev sdb, sector ...` means the device failed a request: a dying disk, a cable, or a cloud volume detached. A burst of `ata1: hard resetting link` points at the cable or the controller. Follow with SMART.

```sh changes
sudo growpart /dev/DISK 1
```

Grows partition 1 to the end of the disk (the `cloud-guest-utils` or `cloud-utils-growpart` package). Prints **CHANGED** with the old and new size. Then grow the filesystem. For `nvme0n1` the partition is `nvme0n1p1`, so write `/dev/nvme0n1 1`.

### LVM

```sh
sudo pvs
sudo vgs
sudo lvs
```

Physical volumes, volume groups and logical volumes. **VFree** in the `vgs` output is the room left to extend. **Attr** in `lvs`: the first letter is the type (`-` plain, `t` thin pool, `s` snapshot), the fifth `a` active, the sixth `o` open (mounted).

```sh
sudo lvs -a -o lv_name,vg_name,lv_size,lv_attr,data_percent,metadata_percent,devices
```

**Data%** and **Meta%** on a thin pool or snapshot. A thin pool at 100% (data or metadata) freezes writes with IO errors on every volume in it, so alert well before. **devices** shows which disk a volume sits on.

```sh changes
sudo lvextend -r -L +10G /dev/VGNAME/LVNAME
```

Grows the logical volume by 10 GiB and, with `-r`, its ext4 or XFS filesystem in the same step, while mounted. Needs free extents in the group. It cannot be undone for XFS, which does not shrink.

```text
Insufficient free space: 2560 extents needed, but only 36 available
```

The volume group is out of free extents. **Check** `sudo vgs -o vg_name,vg_size,vg_free`. Add a physical volume (`vgextend`) or use a smaller size.

```text
WARNING: Couldn't find device with uuid 4Kf3vH-xB2d-7mQe-9tLs-Zc1Y-8wRa-Pq0DnU.
```

A disk of the volume group is missing: unplugged, a failed multipath, or a cloud volume detached. **Check** `sudo pvs` and `lsblk`. Reattach it before anything else: `vgreduce --removemissing` throws away the volumes that lived on it.

### Software RAID (mdadm)

```sh
cat /proc/mdstat
```

Each array and its members. `[UU]` is healthy, `[U_]` or `[_U]` degraded, `(F)` marks a failed member. A progress bar with `recovery` or `resync` is a rebuild and its ETA; an array shown `inactive` did not assemble.

```sh
sudo mdadm --detail /dev/md0
```

**State** (`clean`, `degraded`, `recovering`), **Failed Devices** and the role of each member. Replace md0 with your array. A degraded RAID 1 or 5 has no redundancy left: until the rebuild ends, a read error on a remaining member loses data.

```sh
sudo mdadm --examine /dev/DISK
```

The RAID metadata on one member, including **Events** and **Array State**. A member with a lower Events count than the others dropped out earlier and holds stale data.

```sh
sudo mdadm --detail --scan
```

Prints the `ARRAY` lines for `mdadm.conf` (`/etc/mdadm/mdadm.conf` on Debian, `/etc/mdadm.conf` on RHEL). An array that comes up as `md127` after a reboot is missing from that file. Rebuild the initramfs afterwards.

```sh danger
sudo mdadm /dev/md0 --fail /dev/DISK --remove /dev/DISK
```

Marks a member failed and removes it, so you can swap the disk. A wrong DISK on an array that is already degraded loses it. Check `/proc/mdstat` first. Then `--add` the new disk and watch the rebuild.

```sh
cat /sys/block/md0/md/sync_action /sys/block/md0/md/mismatch_cnt
```

**sync_action** `idle`, `check`, `resync` or `recover`. **mismatch_cnt** after a `check` should be 0; above 0 on a RAID 1 means the copies differ, which can be a failing disk or a swap file written in flight. Debian runs a monthly check from cron.

### Disk health (SMART and NVMe)

```sh
sudo smartctl -H /dev/DISK
```

The drive's own verdict, `PASSED` or `FAILED`. Package `smartmontools`. A PASSED disk can still be dying: read the attributes. Behind a hardware RAID controller the disk needs `-d megaraid,N`, and a virtual disk has no SMART.

```sh
sudo smartctl -A /dev/DISK
```

On SATA, watch **Reallocated_Sector_Ct** (5), **Current_Pending_Sector** (197) and **Offline_Uncorrectable** (198): any non-zero count that keeps rising means replace the disk. **UDMA_CRC_Error_Count** (199) points at the cable. On NVMe it prints the health log below.

```sh
sudo smartctl -l error /dev/DISK
```

The drive's error log: the last commands it failed, with LBA. Repeated errors at one LBA are a bad region. `-l selftest` shows past self-test results.

```sh
sudo nvme smart-log /dev/DISK
```

NVMe health (package `nvme-cli`). **critical_warning** must be 0. **percentage_used** at 100 is the rated endurance spent. Watch **available_spare** against its threshold, **media_errors**, and the **temperature**.

### ext4 and XFS

```sh
sudo tune2fs -l /dev/DISK | grep -iE 'state|errors behavior|features|reserved block count|mount count'
```

**Filesystem state** `clean` or `not clean`; **Errors behavior** says what the kernel does on an error: `Continue`, `Remount read-only` or `Panic`. **Reserved block count** is the 5% only root can use: `df` can show full while root still writes.

```sh
sudo e2fsck -fn /dev/DISK
```

A read-only ext4 check: it lists problems and fixes none. Run it on an unmounted device; on a mounted one it reports false errors. Exit 0 is clean, 4 means errors left. Mount from a rescue shell if it is the root filesystem.

```sh danger
sudo e2fsck -fy /dev/DISK
```

Repairs ext4 and answers yes to every question. It can move damaged files to `lost+found` and drop others. Unmount first, and copy the device (`dd`, or a cloud snapshot) if the data matters.

```sh changes
sudo resize2fs /dev/DISK
```

Grows ext4 to fill its device, online while mounted. After a device was extended with `growpart` or `lvextend`. Shrinking needs the filesystem unmounted and checked with `e2fsck -f`.

```sh
sudo xfs_info MNT
```

XFS geometry: **agcount**, **bsize**, **ftype=1** (needed by overlay and containers). It takes the mount point, or the device of an unmounted filesystem. XFS grows but never shrinks.

```sh
sudo xfs_repair -n /dev/DISK
```

A no-modify check of an unmounted XFS filesystem: reports damage, repairs nothing. Exit 1 means corruption found. A dirty log needs the filesystem mounted and unmounted once (replays the log) before repair.

```sh danger
sudo xfs_repair /dev/DISK
```

Repairs XFS and may discard damaged inodes and directories. Unmounted only, and copy the device first. If it refuses because of the log, `-L` zeroes the log and loses recent changes: last resort, after trying `mount -o ro,norecovery`.

```sh changes
sudo xfs_growfs MNT
```

Grows a mounted XFS filesystem to the size of its device. XFS cannot shrink, so check the size before you extend the volume.

```text
EXT4-fs error (device sdb1): ext4_find_entry:1455: inode #2: comm app: reading directory lblock 0
EXT4-fs (sdb1): Remounting filesystem read-only
```

Metadata the kernel could not read or that fails its checksum. With `errors=remount-ro` the filesystem turns read-only after the first one. **Check** `dmesg` right before for I/O errors: a failing disk, not only the filesystem. Then unmount and `e2fsck`.

```text
XFS (sdb1): Metadata corruption detected at xfs_buf_ioend+0x..., xfs_inode block 0x...
XFS (sdb1): Unmount and run xfs_repair
```

XFS found damaged metadata and shut the filesystem down, so every call fails with "Input/output error" or "Structure needs cleaning". Look for I/O errors above it. Unmount and run `xfs_repair -n`, then without `-n`.

```text
XFS (sdb1): Filesystem has duplicate UUID 0a1b2c3d-1111-2222-3333-444455556666 - can't mount
```

A clone or snapshot of an XFS volume is mounted next to the original. `mount` itself only prints "wrong fs type, bad option, bad superblock": read `dmesg`. For a temporary mount use `-o nouuid`; to keep both, give the copy a new UUID with `xfs_admin -U generate` while it is unmounted.

### Mounts and fstab

```sh
findmnt --verify --verbose
```

Checks `/etc/fstab` for unknown filesystem types, missing mount points, unreachable sources and bad options, without mounting anything. Run it after every edit, before the reboot that would find the mistake for you.

```sh
findmnt -no SOURCE,FSTYPE,OPTIONS MNT
```

What is mounted at a path, from where, and with which options. **ro** is read-only, **noexec** explains exit 126, **nosuid** and **nodev** are the hardening options. Use `findmnt -T FILE` to learn which filesystem holds a file.

```sh changes
sudo mount -a
```

Mounts everything in `/etc/fstab` that is not mounted yet and prints each failure. A way to test an edit while you can still fix it. Add `nofail` to entries that must not stop the boot.

```sh changes
sudo mount -o ro,norecovery /dev/DISK MNT
```

A read-only rescue mount of XFS that skips log replay, to copy data off a damaged filesystem. For ext4 the option is `ro,noload`. Copy first, repair after.

```text
umount: /mnt: target is busy.
```

A process has a file open or its working directory there. **Check** `sudo fuser -vm MNT` (the **ACCESS** column: `c` working directory, `f` open file) or `lsof +f -- MNT`, stop the holder and retry. `umount -l` detaches now and cleans up later; it can leave writers stuck.

```text
mount: /mnt: wrong fs type, bad option, bad superblock on /dev/sdb1, missing codepage or helper program, or other error.
```

A catch-all from `mount`: the device has no filesystem, the type is wrong (`LVM2_member`, `linux_raid_member` or `crypto_LUKS` need their own tools first), or the filesystem is damaged. **Check** `lsblk -f` and `sudo dmesg | tail`: the kernel says why.

```text
Timed out waiting for device ... /dev/disk/by-uuid/0a1b2c3d-...
Dependency failed for ... /data.
```

An `/etc/fstab` entry names a device that is not there, and the boot drops to emergency mode ("You are in emergency mode"). Log in with the root password, fix the entry (`blkid` has the UUID), or add `nofail,x-systemd.device-timeout=10s`. The journal is `journalctl -xb`. Newer systemd can put the unit name before the description (`data.mount - /data`).

### NFS

```sh
nfsstat -m
```

Every NFS mount on a client with its real options: **vers**, **proto**, **hard** or **soft**, **timeo**, **retrans**, **sec** and the server address. Package `nfs-common` on Debian, `nfs-utils` on RHEL. A mount without `hard` can return IO errors and corrupt data.

```sh
nfsiostat 1 3 MNT
```

Per-mount NFS rates: operations a second, kB a second, retransmissions and **avg RTT** in milliseconds. A high RTT is the network or an overloaded server; **retrans** above 0 means lost or slow replies.

```sh
rpcinfo -p HOST
```

The RPC services the server has registered. NFSv3 needs `portmapper`, `mountd` and `nfs`, and for locking `nlockmgr` and `status`; NFSv4 needs only TCP port 2049. "Connection refused" or a timeout means the firewall or rpcbind is down.

```sh
showmount -e HOST
```

The server's export list and who may mount each. It speaks NFSv3 and can fail against an NFSv4-only server that mounts fine. Compare the client's address with the list.

```sh
sudo exportfs -v
```

Run on the server: each export with its options (**rw**, **sync**, **root_squash**) and the clients it allows. After editing `/etc/exports`, `sudo exportfs -ra` applies it without a restart.

```text
nfs: server HOST not responding, still trying
```

A hard mount keeps retrying forever, so processes using it sit in state D until the server answers. "nfs: server HOST OK" follows when it does. **Check** the network path and `rpcinfo -p HOST`. `umount -f` or `-l` is the last resort.

```text
mount.nfs: access denied by server while mounting HOST:/export
```

The server refuses this client. **Check** `sudo exportfs -v` for the client's address or network, and `secure`: the client must use a port under 1024 unless the export says `insecure`. A name in `/etc/exports` must resolve the same way on the server.

```text
mount.nfs: mounting HOST:/export failed, reason given by server: No such file or directory
```

The path is not exported. With NFSv4 the path is relative to the export marked `fsid=0` (or the pseudo-root), so `/export` may need to be `/`. **Check** `sudo exportfs -v` on the server.

```text
mount.nfs: rpc.statd is not running but is required for remote locking.
mount.nfs: Either use '-o nolock' to keep locks local, or start statd.
```

NFSv3 locking needs `rpc.statd` on the client. Start it (the `rpc-statd` service) or mount with NFSv4, which locks in the protocol. `nolock` keeps locks local, which is only safe if no other client uses the files.

## DNS, ports and packets

Resolve, then reach, then read the sockets, then look at the packets. Each layer answers before the next is worth asking.

### Resolve

```sh
getent hosts NAME; echo "exit $?"
```

Resolves the way the app does, through the sources listed in `/etc/nsswitch.conf`, usually `/etc/hosts` first, then DNS. Exit 2 means the name was not found.

```sh
getent ahosts NAME
```

Every address, in the order a program using `getaddrinfo` will try them. A dead IPv6 address listed first explains a slow connect that works with `curl -4`.

```sh
grep '^hosts:' /etc/nsswitch.conf
```

The lookup order. `files dns` is the plain default. On systemd hosts you may see `files resolve [!UNAVAIL=return] dns`, and `[NOTFOUND=return]` stops the search at the first source that says no. Alpine's musl libc ignores this file.

```sh
dig +short NAME
```

DNS only. A different answer from `getent` means `/etc/hosts` or a search domain is involved.

```sh
dig @RESOLVER NAME +noall +answer
```

Asks one specific resolver and shows the TTL left on the record. A stale cache shows here.

```sh
dig NAME | grep -E 'status:|Query time|SERVER'
```

The **status** is the verdict (see the DNS answers group), **Query time** the latency, **SERVER** the resolver that answered. A second run much faster than the first was a cache hit.

```sh
dig +tcp NAME
```

DNS over TCP port 53. If this works and the plain query times out, a firewall drops UDP 53 or large UDP replies.

```sh
dig +trace NAME
```

Walks from the root servers down to the authoritative ones, so you see which delegation is wrong. It needs direct outbound DNS: behind a forwarding-only network it times out.

```sh
readlink -f /etc/resolv.conf; cat /etc/resolv.conf
```

Who manages the file and what it holds. A path under `/run/systemd/resolve/` means systemd-resolved, and `nameserver 127.0.0.53` is only its local stub. Check **search** and **options ndots** too: they change what a short name becomes.

```sh
resolvectl status
```

The upstream servers systemd-resolved really uses, per interface. 127.0.0.53 in `resolv.conf` is only its local stub.

```sh
resolvectl query NAME
```

Resolves through resolved's own stack and says which interface and protocol answered, and whether the data came from the cache or the network. It also tries LLMNR and mDNS, which `dig` never does.

```sh
resolvectl dns IFACE; resolvectl domain IFACE
```

The DNS servers and the search or routing domains of one link. A domain written `~example.com` sends only that zone to this link's servers: the usual cause of split-DNS surprises over a VPN.

```sh
resolvectl statistics
```

Cache size, hits and misses, and transaction counts. A growing count of timeouts or failure responses points at a broken upstream.

```sh changes
resolvectl flush-caches
```

Empties the systemd-resolved cache. Use it after you fix a record and the host still returns the old one.

```sh
journalctl -u systemd-resolved --since '30 min ago' --no-pager | tail -30
```

The resolver's own log: servers switched, features downgraded, timeouts. Look for "Using degraded feature set".

### DNS answers and errors

```text
status: NXDOMAIN
```

The name does not exist at the server that answered. Check the spelling, the zone, and whether a search domain was appended. A private zone asked of a public resolver gives this too.

```text
status: SERVFAIL
```

The resolver tried and failed: a broken or unreachable authoritative server, a lame delegation, or a failed DNSSEC check. Retry with `dig +cd NAME` to bypass DNSSEC validation: if that works, the signatures are the problem.

```text
status: REFUSED
```

The server will not answer you: a recursion restriction or an ACL. Ask the resolver your hosts are meant to use.

```text
ANSWER: 0
```

With status: NOERROR, the name exists but has no record of the type you asked for. A host with only an A record answers an AAAA query like this.

```text
;; communications error to 127.0.0.1#53: connection refused
```

Nothing listens at that address. Often `resolv.conf` points at a local stub or cache that is not running.

```text
;; communications error to 10.255.255.254#53: timed out
```

The packets are dropped or the server is down. Watch the queries with `tcpdump -ni any port 53`, and try the other servers listed in `resolv.conf`.

```text
;; no servers could be reached
```

`dig` tried every configured server and none answered: no route, a firewall, or the wrong resolver address.

```text
Temporary failure in name resolution
```

glibc's `EAI_AGAIN`: no resolver answered. Look at `resolv.conf`, the route, and the firewall. A typo gives "Name or service not known" instead.

```text
Name or service not known
```

glibc's `EAI_NONAME`: a resolver answered and said the name does not exist. Compare `getent hosts NAME` with `dig NAME`.

```text
curl: (6) Could not resolve host: NAME
```

curl's version of the two errors above. In a container, the name often needs a search domain or a cluster suffix that the host does not have.

```text
dial tcp: lookup NAME on 127.0.0.11:53: no such host
```

Go's resolver error. The address after "on" is the server asked: 127.0.0.11 is Docker's embedded DNS, a cluster IP is CoreDNS.

```text
java.net.UnknownHostException: NAME
```

Java's resolver failed. The JVM caches lookups: 30 seconds for a success (`networkaddress.cache.ttl`) and 10 for a failure (`networkaddress.cache.negative.ttl`) by default.

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
ip -o link | awk '{print $2, $4, $5}'
```

Each interface with its MTU. Mismatched MTUs along a path, such as 1500 on the host and 1450 on an overlay network, cause the stalls described under path MTU.

```sh
nc -zv -w3 HOST PORT
```

Is the TCP port open from here.

```sh
timeout 3 bash -c '</dev/tcp/HOST/PORT' && echo open
```

The same check on a minimal host without `nc`.

```sh
mtr -rwc 50 HOST
```

Loss and latency per hop. Loss at a middle hop that does not carry on to the end is ICMP rate limiting; ignore it.

```sh
ping -M do -s 1472 HOST
```

Path MTU test: 1472 bytes plus 28 of headers fills 1500. Lower the size until replies come back. "message too long, mtu=1500" is your own interface refusing; a "Frag needed" reply names the hop whose MTU is smaller.

```sh
tracepath -n HOST
```

Discovers the path MTU hop by hop and prints `pmtu` as it shrinks. A path that works for pings and small requests but hangs on large responses is a PMTU blackhole.

```sh
tcpdump -ni any 'icmp[icmptype] == 3 and icmp[icmpcode] == 4'
```

ICMP "fragmentation needed" messages. None arriving while big transfers stall means a firewall drops them, so the sender never learns the right size. For IPv6 the message is "packet too big" (ICMPv6 type 2), and dropping it breaks the path entirely.

```sh
sysctl net.ipv4.tcp_mtu_probing
```

0 means the kernel trusts ICMP to learn the path MTU. Setting 1 makes TCP probe when it stalls, which works around a blackhole without fixing the dropped ICMP.

```sh
ping -c3 -I IFACE IP
```

Pings out of one interface. On a host with two networks, this separates a route problem from a host problem.

### Sockets

```sh
ss -tlnp
```

What listens, on which address, owned by which process. 127.0.0.1 is local only; 0.0.0.0 or [::] is every interface.

```sh
ss -ulnp
```

The same for UDP. DNS, syslog and StatsD listeners show here. UDP has no state, so a port that is not listed refuses with ICMP.

```sh
ss -tlnp 'sport = :8080'
```

Who owns one port. Use it when a service says "Address already in use".

```sh
ss -tnp 'dport = :5432'
```

Open connections to a port (here the database) with the owning process.

```sh
ss -s
```

Totals per state. The fast way to spot thousands of TIME_WAIT or CLOSE_WAIT.

```sh
ss -tan state close-wait
```

Only the sockets in one state, with addresses. Other states: `established`, `time-wait`, `syn-sent`, `syn-recv`, `fin-wait-2`.

```sh
ss -ltn
```

On a LISTEN socket, Recv-Q is the accept queue now and Send-Q its limit. Recv-Q near Send-Q: the app is not accepting fast enough. The limit is the smaller of the app's backlog and `net.core.somaxconn`.

```sh
ss -tin dst IP
```

Per-connection TCP internals: **rto**, **rtt**, **cwnd**, **mss**, **pmtu**, and **retrans** once a retransmit has happened. A **rtt** that jumps or a **retrans** count that climbs is a lossy path.

```sh
ss -tmn state established
```

Adds the socket buffers as `skmem`: **rb** and **tb** are the receive and send buffer sizes, **d** the drops. A send queue that stays full with a small **cwnd** means a slow peer or a lossy path.

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
tcpdump -ni any 'tcp[tcpflags] & tcp-rst != 0'
```

Only the resets, with who sent them. A reset from the server side after a long idle period often comes from a firewall or NAT timing out the connection.

```sh
tcpdump -ni any -c 20 'udp port 53'
```

The DNS queries a host really sends and the replies it gets. A query repeated with no reply is a drop; a reply from a different address than the query went to is rejected.

```sh
nft list ruleset
```

Every firewall rule on a modern distribution. The `iptables` command is often a front end to it.

```sh
nft -a list ruleset
```

The same, with a handle number on each rule. You need it to delete a single rule with `nft delete rule`, which takes the table, the chain and the handle.

```sh changes
nft add table inet tracetmp
nft add chain inet tracetmp pre '{ type filter hook prerouting priority -300; }'
nft add rule inet tracetmp pre ip saddr IP meta nftrace set 1
nft monitor trace
```

Adds a temporary table that marks packets from one address for tracing, then prints every table, chain and rule they hit and the verdict. Press Ctrl-C, then remove it with `nft delete table inet tracetmp`.

```sh changes
nft delete table inet tracetmp
```

Removes the temporary trace table above. It leaves every other table alone.

```sh
iptables --version
```

"(nf_tables)" means `iptables` writes nftables rules and `nft list ruleset` shows them all. "(legacy)" means the old tables, which `nft` does not show. Check both when rules seem to be missing.

```sh
iptables -L -n -v --line-numbers
```

Rules with packet counters. Run it twice and watch which counter climbs. It shows the filter table only: add `-t nat` for the port forwarding and masquerading of Docker and kube-proxy.

```sh
iptables-save | head -60
```

Every table in a form you can diff and read, including the nat rules Docker and kube-proxy write. Compare with a healthy node.

```sh
sysctl net.netfilter.nf_conntrack_count net.netfilter.nf_conntrack_max
```

The connection tracking table. When it is full the kernel drops new connections and logs "table full" in `dmesg`.

```sh
conntrack -S
```

One line per CPU. **insert_failed**, **drop**, **early_drop** and **invalid** rising mean the table is full or NAT collisions are happening. **chaintoolong** points at a hash table that is too small.

```sh
conntrack -L -p tcp --state ESTABLISHED | wc -l
```

How many established flows are tracked. It lists from the same table the sysctl counts. Heavy on a full table: `conntrack -C` counts the entries without listing them. Replace `ESTABLISHED` with `TIME_WAIT` or `SYN_SENT` to see which state fills it.

```sh
sysctl net.netfilter.nf_conntrack_tcp_timeout_established
```

How long an idle established flow stays tracked: 432000 seconds, 5 days, by default. A long value fills the table with dead flows, a short one resets idle connections.

### Neighbours and drops

```sh
ip -s link show IFACE
```

Per interface counters. **errors** and **dropped** on RX or TX should be zero. Run it twice and compare: only a rising number matters.

```sh
ip -s -s link show IFACE
```

The detailed breakdown: RX **length**, **crc**, **frame**, **fifo**, **overrun**, and TX **carrier** or **aborted**. CRC and frame errors are a cable or a duplex problem, **overrun** and **missed** are a NIC that cannot keep up.

```sh
ethtool -S IFACE | grep -iE 'drop|miss|err|fifo|discard'
```

The driver's own counters, which name the cause better than `ip -s`: a full ring buffer, a queue drop. The names depend on the driver. A virtual NIC shows few.

```sh
nstat -az | grep -E 'IpInDiscards|IpInHdrErrors|IpOutNoRoutes|UdpRcvbufErrors|TcpExtTCPBacklogDrop|TcpExtListenDrops'
```

Counters for why the kernel dropped a packet. **UdpRcvbufErrors**: a UDP socket buffer overflowed, so raise `net.core.rmem_max` or read faster. **IpOutNoRoutes**: no route. **TcpExtTCPBacklogDrop**: a busy socket.

```sh
nstat
```

Run without `-a`, it prints only what changed since its last run. Run it once, wait during the problem, then run it again to see the counters that moved.

```sh
awk '{print NR-1, $1, $2, $3}' /proc/net/softnet_stat
```

One line per CPU in hexadecimal: processed, dropped, time_squeeze. A growing **dropped** means the per-CPU backlog overflowed (`net.core.netdev_max_backlog`), and **time_squeeze** means the CPU ran out of budget in the receive loop.

```sh
ip neigh show
```

The ARP (IPv4) and neighbour discovery (IPv6) table. REACHABLE and STALE are fine. **FAILED** or **INCOMPLETE** on the gateway means nobody answered the ARP request: a wrong VLAN, a dead peer, or a cable.

```sh
ip -s neigh show dev IFACE
```

Adds the age of each entry and the probe count. Many entries in INCOMPLETE together suggest a scan, or a subnet mask set too wide.

```sh
arping -c 3 -I IFACE IP
```

Asks who has that address at layer 2, with no IP routing involved. A reply from two different MAC addresses is a duplicate IP address. This is the iputils `arping`; the Habets one takes `-i` for the interface.

```text
arp_cache: neighbor table overflow!
```

Seen in `dmesg`: more neighbours than `net.ipv4.neigh.default.gc_thresh3` allows, typical on a large flat network or a node with many pods. Raise the three `gc_thresh` values.

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

```text
FIN_WAIT2 piling up
```

You closed and the peer has not. The peer app holds its side open, or its reply was lost. An orphaned socket gives up after `net.ipv4.tcp_fin_timeout`, 60 seconds by default.

```text
ESTAB with a large Send-Q
```

Bytes you sent that the peer has not acknowledged: a slow reader, a full window, or loss. Look at `ss -ti` for **retrans** and a small **cwnd**.

```text
ESTAB with a large Recv-Q
```

Bytes that arrived and your app has not read: the app is slow or blocked. The network is not the bottleneck.

### Connection errors

```text
Connection refused
```

The host answered with a reset: nothing listens on that port, or the app binds another address. Check `ss -tlnp` on the target.

```text
Connection timed out
```

No answer at all: a firewall dropping, a wrong route, a dead host. A refusal would have been immediate.

```text
No route to host
```

The kernel has no usable route, or an ARP request got no answer on the local network. On the same subnet, check `ip neigh`.

```text
Network is unreachable
```

No route to that network at all, often a missing default gateway or an interface that is down. Compare with `ip route get IP`.

```text
Connection reset by peer
```

The other side sent a RST mid-connection: the app crashed, a proxy hit its timeout, or a firewall or NAT dropped its state for an idle flow.

```text
bind: Address already in use
```

Another process holds the port, or a socket from a previous run is in TIME_WAIT without `SO_REUSEADDR`. Find the owner with `ss -tlnp 'sport = :PORT'`.

```text
connect: Cannot assign requested address
```

On an outgoing connection: the local ephemeral ports to that destination are exhausted (see `net.ipv4.ip_local_port_range`). On a bind: the address is not on this host.

## TLS and certificates

Most TLS outages are an expiry, a missing intermediate, a name that is not in the certificate, a client that does not trust the issuer, or a wrong clock.

### Inspect what the server sends

```sh
openssl s_client -connect HOST:443 -servername HOST -verify_hostname HOST </dev/null
```

The handshake, the chain the server sends, and "Verify return code: 0 (ok)". Without `-verify_hostname`, 0 (ok) means only that the chain is trusted, not that the certificate is for HOST. `-servername` (SNI) matters when you connect to an IP: without it you may get the default certificate.

```sh
openssl s_client -connect HOST:443 -servername HOST -brief </dev/null
```

Five lines instead of a page: **Protocol version**, **Ciphersuite**, the peer certificate and **Verification**. Use it in scripts and for a quick look.

```sh
openssl s_client -connect HOST:443 -servername HOST </dev/null 2>/dev/null | openssl x509 -noout -subject -issuer -dates -ext subjectAltName
```

Who the certificate is for, who signed it, when it expires, and the names it covers.

```sh
openssl s_client -connect HOST:443 -servername HOST -showcerts </dev/null
```

Every certificate sent. A missing intermediate works in browsers (they fetch it) and fails in curl, Java, Go and Python.

```sh
openssl s_client -connect HOST:443 -servername HOST -showcerts </dev/null 2>/dev/null | grep -c 'BEGIN CERTIFICATE'
```

How many certificates the server sent. 1 means the leaf only: the intermediate is missing. 2 is normal for a leaf and one intermediate. The root is not needed.

```sh
openssl s_client -connect HOST:443 -servername HOST </dev/null 2>/dev/null | sed -n '/^Certificate chain/,/^---/p'
```

The chain as the server sent it. Line 0 must be the leaf, each `i:` issuer must be the next line's `s:` subject, and the order matters to strict clients.

```sh
openssl crl2pkcs7 -nocrl -certfile chain.pem | openssl pkcs7 -print_certs -noout
```

The subject and issuer of every certificate in a bundle file, in file order. Use it to check a chain file before you deploy it: the leaf first, then the intermediates.

```sh
openssl x509 -in cert.pem -noout -ext authorityInfoAccess,crlDistributionPoints
```

Where the issuer certificate and the revocation data live. **CA Issuers** is the URL a client fetches a missing intermediate from; **OCSP** is the responder. "No extensions" means the certificate has none, as with a private CA.

```sh
openssl x509 -in cert.pem -noout -subject -issuer -serial -fingerprint -sha256
```

The identity of a certificate file. Compare the fingerprint with what the server sends to confirm you deployed the file you think you did.

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
curl -v --resolve HOST:443:IP https://HOST/health
```

Hits one backend with the real hostname and SNI, bypassing DNS and the load balancer.

```sh
curl -sS -o /dev/null -w '%{ssl_verify_result} %{http_version} %{remote_ip}\n' https://HOST/
```

**ssl_verify_result** is OpenSSL's verdict: 0 trusted, 10 expired, 18 self-signed, 20 unknown issuer, 21 first certificate unverifiable. It stays readable with `-k`, which lets the request through anyway.

```sh
curl -vsI https://HOST/ 2>&1 | grep -E 'SSL connection|subject:|expire date|issuer:|ALPN'
```

What curl negotiated: TLS version and cipher, the certificate subject, expiry and issuer, and the ALPN protocol the server accepted.

### Negotiation: SNI, ALPN, versions, OCSP

```sh
openssl s_client -connect HOST:443 -noservername </dev/null 2>/dev/null | openssl x509 -noout -subject
```

The certificate a client gets when it sends no SNI: an old client, a health check, or a request straight to the IP. Compare with the one you get with `-servername`.

```sh
openssl s_client -connect HOST:443 -servername HOST -alpn h2,http/1.1 </dev/null 2>/dev/null | grep ALPN
```

"ALPN protocol: h2" means the server speaks HTTP/2 on this port. "No ALPN negotiated" means it chose neither, and an HTTP/2 client such as gRPC will fail.

```sh
for v in tls1_2 tls1_3; do printf '%s: ' $v; openssl s_client -connect HOST:443 -servername HOST -$v </dev/null 2>&1 | grep -E '^New,|alert' | head -1; done
```

Which protocol versions the server accepts. A line with "alert protocol version" means that version is refused. Clients stuck on TLS 1.0 or 1.1 need the server to allow them again, which you should not do.

```sh
openssl s_client -connect HOST:443 -servername HOST -tls1_2 -cipher 'ECDHE-RSA-AES128-GCM-SHA256' </dev/null 2>&1 | grep -E 'Cipher is|alert'
```

Tests one TLS 1.2 cipher. "Cipher is (NONE)" with "alert handshake failure" means the server does not offer it. For TLS 1.3 use `-ciphersuites` instead.

```sh
openssl s_client -connect HOST:443 -servername HOST -status </dev/null 2>/dev/null | grep -E 'OCSP response:|Cert Status|This Update|Next Update'
```

OCSP stapling. "no response sent" means the server staples nothing. A stapled answer shows **Cert Status: good** and a **This Update** and **Next Update** window: a Next Update in the past is a stale staple.

### Chains and trust

```sh
openssl verify -CAfile root.pem -untrusted inter.pem cert.pem
```

Builds the chain from the leaf to a trusted root and says which link fails. `-CAfile` holds the roots you trust, `-untrusted` the intermediates the server sent. Without the intermediate you get error 20.

```sh
openssl verify -CAfile root.pem -untrusted inter.pem -verify_hostname NAME cert.pem
```

Also checks the name. "hostname mismatch" (error 62) means NAME is not in the certificate's SAN list.

```sh
curl -v https://HOST/ 2>&1 | grep -E 'CAfile|CApath'
```

The trust store curl uses. On Debian it is `/etc/ssl/certs/ca-certificates.crt`, on RHEL `/etc/pki/tls/certs/ca-bundle.crt`. `curl --cacert FILE` replaces it for one call, and `SSL_CERT_FILE=FILE` does the same for curl and many OpenSSL programs.

```sh
openssl version -d
```

The directory OpenSSL reads its default trust store from. Programs linked to OpenSSL use `cert.pem` and `certs/` under it, unless `SSL_CERT_FILE` or `SSL_CERT_DIR` is set.

```sh changes deb
cp root.pem /usr/local/share/ca-certificates/private-root.crt && update-ca-certificates
```

Adds a private CA to the system store on Debian and Ubuntu. The file must end in `.crt`. It fixes curl, wget, OpenSSL programs and the distribution's own OpenJDK, but not a vendor JDK (a Temurin tarball, a container image) or Node (`NODE_EXTRA_CA_CERTS`).

```sh changes rhel
cp root.pem /etc/pki/ca-trust/source/anchors/ && update-ca-trust
```

The same on RHEL, Rocky, Alma and Fedora. It fixes curl, wget, OpenSSL programs and the distribution's own OpenJDK, but not a vendor JDK (a Temurin tarball, a container image) or Node (`NODE_EXTRA_CA_CERTS`).

```sh
python3 -c 'import ssl; print(ssl.get_default_verify_paths())'
```

Where Python looks for CAs. A `requests` installed with pip ignores it and uses the `certifi` bundle, or `REQUESTS_CA_BUNDLE` when set. Node uses its built-in list, plus the file in `NODE_EXTRA_CA_CERTS`.

```sh
keytool -list -cacerts | grep -ci 'trustedCertEntry'
```

How many CAs the JVM trusts. The distribution's own OpenJDK follows the system store (Debian and Ubuntu through ca-certificates-java, RHEL through `/etc/pki/ca-trust/extracted/java/cacerts`); a vendor JDK reads its own `cacerts` file. The store password is `changeit` unless someone changed it, and `keytool` prompts for it.

```sh changes
keytool -importcert -trustcacerts -cacerts -alias private-root -file root.pem
```

Adds a CA to the JVM's trust store. It prompts for the store password and asks you to confirm the certificate. A new JDK or a fresh image can bring back the stock file and lose the import, so do it in the image build.

### Expiry across a whole host

```sh
nginx -T 2>/dev/null | awk '$1 == "ssl_certificate" {gsub(";", "", $2); print $2}' | sort -u | while read -r f; do printf '%s  ' "$f"; openssl x509 -in "$f" -noout -enddate; done
```

Every certificate nginx loads and when it expires, read from the live config. Relative paths are resolved against the directory of nginx.conf, so run it as root from there (`cd /etc/nginx`).

```sh
find /etc -type f \( -name '*.pem' -o -name '*.crt' \) | while read -r f; do openssl x509 -in "$f" -noout -checkend 2592000 >/dev/null 2>&1 || echo "$f"; done
```

Files that hold a certificate expiring within 30 days, plus every file that is not a plain certificate, such as keys and bundles, which only report their first certificate. Follow up with the next command.

```sh
find /etc -type f -name '*.pem' | while read -r f; do printf '%s  ' "$f"; openssl x509 -in "$f" -noout -enddate 2>/dev/null || echo 'not a certificate'; done
```

The expiry date of each certificate file, and the files that are not certificates. Sort by the date to find what expires first.

```sh
printf 'changeit\n' | keytool -list -v -keystore FILE | grep -E 'Alias name|Valid from'
```

The aliases in a Java keystore with their validity windows. Replace `changeit` with the real password, typed at a prompt instead of piped when it is a secret.

```sh
kubectl -n NS get secret APP -o jsonpath='{.data.tls\.crt}' | base64 -d | openssl x509 -noout -enddate
```

The expiry of a certificate stored in a Kubernetes TLS secret. Cert-manager renews its secrets on its own: if this date is near, look at the Certificate resource's events.

```sh
certbot certificates
```

Every certificate certbot manages, its domains, the **Expiry Date** and "VALID: N days". If renewal failed, `certbot renew --dry-run` shows why. It runs your `--pre-hook` and `--post-hook` (not `--deploy-hook`), reloads nginx or apache when those plugins are used, and `--standalone` needs port 80 free.

### Mutual TLS (client certificates)

```sh
openssl s_client -connect HOST:443 -servername HOST </dev/null 2>/dev/null | sed -n '/Acceptable client certificate CA names/,/Requested Signature/p'
```

A server that asks for a client certificate lists the CAs it accepts here. "No client certificate CA names sent" means it does not ask, or asks without a list.

```sh
openssl s_client -connect HOST:443 -servername HOST -cert client.pem -key client.key </dev/null
```

The handshake as a client with a certificate. In TLS 1.3 the handshake can look fine and the server rejects you only on the first request, so follow it with a real request.

```sh
curl --cacert root.pem --cert client.pem --key client.key https://HOST/
```

A request with a client certificate. Without them, a server that requires mTLS answers with an alert (see the error entries) or an nginx 400 page, "No required SSL certificate was sent".

```sh
openssl x509 -in client.pem -noout -ext extendedKeyUsage,keyUsage
```

A client certificate needs **TLS Web Client Authentication** in its extended key usage, or the server refuses it with "unsupported certificate purpose". No such line, no restriction: it is allowed.

### Certificate and handshake errors

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

```text
verify error:num=20:unable to get local issuer certificate
```

OpenSSL cannot link the leaf to a trusted CA. With `-showcerts`, count the certificates the server sends: one means the intermediate is missing.

```text
verify error:num=21:unable to verify the first certificate
```

OpenSSL could not verify even the first certificate, usually because the intermediate that signed it was not sent and the issuer is unknown.

```text
verify error:num=18:self-signed certificate
```

The server's own certificate is its issuer and is not in your trust store. A private CA's certificate on the server, a default certificate, or a proxy that re-signs traffic.

```text
verify error:num=19:self-signed certificate in certificate chain
```

The chain ends in a root that you do not trust. Add that root to the client's trust store, or find who re-signs the traffic.

```text
verify error:num=62:hostname mismatch
```

The chain is fine and the name is wrong. Compare `-ext subjectAltName` with the name you connected to, and check SNI.

```text
unsupported certificate purpose
```

The certificate's extended key usage does not allow this use: a server certificate without serverAuth, or a client certificate without clientAuth.

```text
SSL alert number 120
```

Alert 120, no_application_protocol: the client offered ALPN protocols the server does not speak, such as h2 to a server that only knows http/1.1.

### TLS alerts from the peer

```text
tlsv13 alert certificate required
```

The server needs a client certificate and you sent none. In TLS 1.3 curl reports it on the first read, as exit 56.

```text
tlsv1 alert unknown ca
```

The server does not trust the issuer of the client certificate you sent. Check the CA names it lists with the mTLS command above.

```text
tlsv1 alert protocol version
```

The server does not support the version you offered. Test the versions with the loop above.

```text
sslv3 alert handshake failure
```

No cipher in common, or the server could not use your certificate. Test ciphers one at a time with `-cipher`.

### curl exit codes

```text
curl: (60) SSL certificate problem: unable to get local issuer certificate
```

The server's chain does not reach a root curl trusts. Look at the file under `CAfile` in `curl -v`, and at the intermediate. Other (60) texts: "certificate has expired", "self-signed certificate".

```text
curl: (60) SSL: no alternative certificate subject name matches target host name 'HOST'
```

The certificate does not cover that name. Connecting by IP triggers it too, as IP addresses need an IP entry in the SAN.

```text
curl: (35) OpenSSL/3.0.13: error:0A00010B:SSL routines::wrong version number
```

Exit 35 is a failed handshake. This text means the other end is not speaking TLS, so look at the port and any proxy in front of it.

```text
curl: (56) OpenSSL SSL_read: OpenSSL/3.0.13: error:0A00045C:SSL routines::tlsv13 alert certificate required, errno 0
```

Exit 56 after the handshake: the server wanted a client certificate. Pass `--cert` and `--key`.

```text
curl: (58) could not load PEM client certificate
```

The `--cert` file is missing, unreadable, in the wrong format, or the key is encrypted. Check each with `openssl x509 -in client.pem -noout` and `openssl pkey -in client.key -noout`.

```text
curl: (77) error setting certificate file
```

The file given with `--cacert` does not exist or is not readable. Check the path and the permissions.

### Java and Go errors

```text
PKIX path building failed: sun.security.provider.certpath.SunCertPathBuilderException: unable to find valid certification path to requested target
```

Java does not trust the chain: the CA is not in its `cacerts`, or the server omits the intermediate. Java does not fetch missing intermediates. Import the CA, or fix the server.

```text
java.security.cert.CertificateExpiredException: NotAfter: Sat Feb 01 00:00:00 GMT 2020
```

The certificate or one in its chain expired on that date. The message is wrapped in "PKIX path validation failed: validity check failed".

```text
No subject alternative DNS name matching NAME found.
```

The certificate has DNS SANs and none matches. "No name matching NAME found" means it has no DNS SAN and the CN did not match either. For an IP, the SAN needs an IP entry.

```text
javax.net.ssl.SSLHandshakeException: Received fatal alert: certificate_required
```

The server asked for a client certificate. Give the JVM a client keystore (`javax.net.ssl.keyStore`) and supply its password from the app configuration, not the command line.

```text
javax.net.ssl.SSLException: Unsupported or unrecognized SSL message
```

The JVM spoke TLS to a port that answered in plain text, or the reverse. Check the URL scheme and port.

```text
tls: failed to verify certificate: x509: certificate signed by unknown authority
```

Go does not trust the issuer: a private CA, or a missing intermediate. Go uses the system store. `SSL_CERT_FILE` replaces the default bundle file, so that file must hold the public roots too. `SSL_CERT_DIR` replaces the default list of directories. Older Go versions print only the "x509:" part.

```text
x509: certificate is valid for other.test, not srv.test
```

Go's name mismatch error: it lists the names the certificate covers. Compare them with the host in the URL.

```text
x509: certificate has expired or is not yet valid: current time 2026-11-20T16:15:00Z is after 2020-02-01T00:00:00Z
```

Go prints both dates: "is after" means expired, "is before" means not yet valid, usually a wrong clock. Compare with `date -u`.

```text
x509: cannot validate certificate for 10.0.0.5 because it doesn't contain any IP SANs
```

The URL has an IP address and the certificate has only DNS names. Use the DNS name, or issue a certificate with an IP SAN.

```text
remote error: tls: certificate required
```

Go's version of "the server wants a client certificate". Set `Certificates` in the client's `tls.Config`. The server may also say "bad certificate" when it rejects the one you sent.

```text
tls: first record does not look like a TLS handshake
```

A Go TLS server logs this when a client sends plain text to its TLS port, and a raw `tls.Dial` or gRPC client prints it when it reaches a non-TLS port. A Go HTTP client says "http: server gave HTTP response to HTTPS client" instead. Check the scheme and port, and any proxy.

## HTTP, proxies, load balancers

The status code tells you which layer gave up. The proxy's error log tells you why.

### Measure and test

```sh
curl -so /dev/null -w 'dns %{time_namelookup} tcp %{time_connect} tls %{time_appconnect} ttfb %{time_starttransfer} total %{time_total} code %{http_code}\n' https://HOST/
```

Where the time goes. Every value is cumulative seconds, so ttfb minus tls is the server's thinking time.

```sh
curl -sLo /dev/null -w '%{http_version} conns=%{num_connects} redirects=%{num_redirects} ip=%{remote_ip} size=%{size_download} speed=%{speed_download}\n' https://HOST/
```

What was negotiated and how much work it took. **num_connects** above 1 on a single URL means curl had to open a second connection, for a redirect to another host.

```sh
curl -s -o /dev/null -w '%{json}' https://HOST/
```

Every timing and connection variable curl knows, as one JSON object, for a script to read. Needs curl 7.70 or later. `%{errormsg}` and `%{exitcode}` (7.75 and later) say why a request failed.

```sh
curl -s -o /dev/null -o /dev/null -w '%{num_connects} ' https://HOST/ https://HOST/
```

Two requests in one curl run share a connection. Output `1 0` means the second reused the first. `1 1` means the server closed the connection after the first response, so keep-alive is off or very short.

```sh
curl -sS -o /dev/null -D - https://HOST/
```

Only the response headers. Look for **Server**, **Via**, **X-Forwarded-\***, **Connection**, **Keep-Alive**, **Content-Length** and **Retry-After**: they show which proxy answered and what it promised.

```sh
curl -sv -H 'Host: HOST' http://IP:PORT/health
```

One backend directly, with the virtual host it expects.

```sh
curl -sIL --max-redirs 10 https://HOST/ | grep -iE '^(HTTP|location)'
```

Follows redirects and prints each hop's status and target. A loop of the same two `Location` values is a redirect loop.

### nginx

```sh changes
nginx -t && nginx -s reload
```

Validate, then reload without dropping connections. A failed test leaves the running config alone.

```sh
nginx -T
```

The whole config with every include expanded, as nginx parses it now. It prints any secret written in the config (an `Authorization` header, a password in an upstream URL): mind where you paste it.

```sh
nginx -V 2>&1 | tr ' ' '\n' | grep -E 'with-http_v2|with-http_ssl|with-stream'
```

Which modules this build has. A directive from a missing module makes `nginx -t` fail with "unknown directive".

```sh
nginx -T 2>/dev/null | grep -nE 'keepalive_timeout|keepalive_requests|proxy_(connect|send|read)_timeout'
```

The timeouts set in the config. No line for one means its default applies: **keepalive_timeout** 75s, **proxy_connect_timeout** and **proxy_read_timeout** 60s (and **proxy_send_timeout** 60s).

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

```text
10.0.0.9 "GET /slow HTTP/1.1" 504 rt=1.001 urt=1.001 uct=0.000 uht=- us=504 ua=10.0.0.5:8081
```

An access line from a `log_format` with `$request_time` (**rt**), `$upstream_response_time` (**urt**), `$upstream_connect_time` (**uct**), `$upstream_header_time` (**uht**), `$upstream_status` (**us**) and `$upstream_addr` (**ua**). Add them: they show whether the delay is in connecting or in the app. **uht** `-` means no headers ever came.

### HAProxy

```sh
haproxy -c -f /etc/haproxy/haproxy.cfg
```

Checks the config without starting. A valid file prints `Configuration file is valid` (nothing with `-q`) and exits 0, so test the exit status; warnings and errors print with the line number.

```sh changes
haproxy -c -f /etc/haproxy/haproxy.cfg && systemctl reload haproxy
```

Validate, then start a new process with the new config. The old process keeps its open connections until they end, so a long-lived tunnel can outlast the reload.

```sh
echo 'show stat' | socat stdio /run/haproxy/admin.sock | cut -d, -f1,2,5,8,18,37,38,44
```

One line per frontend, backend and server: **scur** (current sessions), **stot**, **status**, **check_status**, **check_code** and **hrsp_5xx**. The socket path is the `stats socket` line in the config. Read it as a table first, then dig into other columns.

```text
be,s1,0,0,DOWN,L4CON,,0
```

A server row of `show stat`. Status **UP** or **DOWN**, **MAINT** (disabled), **DRAIN** (no new sessions), **NOLB**, and `UP 1/2` when a check has failed but the server is still counted as up. **L4CON** is connection refused, **L4TOUT** a timeout, **L7STS** a bad HTTP status, **L7OK** a pass.

```sh
echo 'show servers state' | socat stdio /run/haproxy/admin.sock
```

Per server: **srv_op_state** (0 stopped, 2 running), **srv_admin_state** (0 none, any other value is a maintenance or drain flag), the address, and **srv_time_since_last_change** in seconds. Use it to see when a server flipped.

```sh
echo 'show info' | socat stdio /run/haproxy/admin.sock | grep -E '^(Version|Uptime_sec|Maxconn|CurrConns|ConnRate|SessRate|Idle_pct|Run_queue|Ulimit-n)'
```

The process: version, uptime, **CurrConns** against **Maxconn**, rates, and **Idle_pct**. A falling **Idle_pct** is CPU saturation. **Maxconn** far below what you expect is a `ulimit` problem.

```sh
echo 'show errors' | socat stdio /run/haproxy/admin.sock
```

The last invalid request or response of each frontend and backend, with the position of the first bad byte. A `<BADREQ>` or 502 in the log with no obvious cause shows its bytes here.

```sh
echo 'show resolvers' | socat stdio /run/haproxy/admin.sock
```

For servers resolved through DNS: queries sent, valid answers, and errors such as **nx**, **timeout** and **refused**. A server shown as "MAINT (resolution)" in `show stat` is waiting for a working answer.

```sh changes
echo 'set server BACKEND/SRVNAME state drain' | socat stdio /run/haproxy/admin.sock
```

Stops new sessions to one server and lets the open ones finish. `state ready` puts it back. `disable server BACKEND/SRVNAME` takes it out at once, and `enable server` returns it. These commands need a `stats socket` line with `level admin`.

### HAProxy log lines

```text
10.0.0.9:58882 [20/Nov/2026:16:17:48.687] fe be_ok/s1 0/0/0/-1/2002 504 198 - - sH-- 1/1/0/0/0 0/0 "GET /slow HTTP/1.1"
```

The HTTP log format: client, time, frontend, **backend/server**, **TR/Tw/Tc/Tr/Ta**, status, bytes, then the four-letter termination state, then connection counts. In the timers, -1 means the phase never happened: here no response came (**Tr**) and the request ended after 2002 ms.

```text
TR/Tw/Tc/Tr/Ta = 0/0/0/-1/2002
```

TR: time to receive the full request headers. Tw: time queued waiting for a server slot. Tc: time to connect to the server. Tr: time to the server's response headers. Ta: total active time of the request. A large **Tw** means the backend is at its maxconn, a large **Tc** a slow connect, a large **Tr** a slow app.

```text
sH--
```

A 504. The first letter `s` is a server-side timeout and `H` says it happened while waiting for the response headers: `timeout server` expired. See **Tr** and the app, or raise the timeout.

```text
SC--
```

A 503. `S` is a server-side failure and `C` says the TCP connection to the server failed or was refused. With `<NOSRV>` as the server in the log, no server was available at all and none was tried.

```text
SH--
```

A 502. The server aborted or crashed before sending its full response headers. Check the app's log at that second, or an IDS cutting the flow. An invalid response is logged as `PH` instead, and its bytes are in `show errors`.

```text
sQ--
```

The request waited in the queue until `timeout queue` (or `timeout connect` when `timeout queue` is not set) and was aborted with a 503: every server was at `maxconn` for too long.

```text
PR--
```

A 400 or a 403. `P` means the proxy itself refused the request, `R` that it was while reading it: invalid HTTP (400, `<BADREQ>` in the log, bytes in `show errors`) or an `http-request deny` rule (403).

```text
cR--
```

A 408 with `<BADREQ>`. The client opened a connection and did not send a full request before `timeout http-request` (or `timeout client` when that is not set). Browsers' pre-opened connections and TCP health checks cause it: harmless in small numbers.

```text
Server app/web1 is DOWN, reason: Layer4 connection problem, info: "Connection refused", check duration: 0ms. 0 active and 0 backup servers left. 0 sessions active, 0 requeued, 0 remaining in queue.
```

A health check failed. The reason names the layer: "Layer4" is TCP, "Layer7 wrong status" an HTTP status that is not the expected one, "Layer7 timeout" a check that was too slow. "0 active" servers left means the backend is now out of service.

### Envoy

```sh
envoy --mode validate -c /etc/envoy/envoy.yaml
```

Loads the config and exits without listening. "configuration ... OK" is the pass line; an error names the field that is wrong.

```sh
curl -s localhost:9901/ready; curl -s localhost:9901/server_info | head -12
```

**LIVE** means ready to serve. `server_info` gives the version, state (**DRAINING** during a drain) and uptime. The admin port has no authentication: bind it to localhost only and never expose it.

```sh
curl -s localhost:9901/clusters | grep -E '::(health_flags|cx_active|cx_connect_fail|rq_error|rq_timeout|rq_total)::'
```

Per upstream host. **health_flags** is `healthy`, or flags such as `/failed_active_hc` and `/failed_outlier_check`. **cx_connect_fail** counts failed connects, **rq_timeout** and **rq_error** the failed requests.

```sh
curl -s 'localhost:9901/stats?usedonly&filter=membership_healthy|membership_total|upstream_rq_timeout|upstream_rq_pending_overflow|upstream_cx_connect_fail'
```

Counters that are not zero, matched by regular expression. **membership_healthy** below **membership_total** is a host out of rotation. **upstream_rq_pending_overflow** rising is circuit breaking.

```sh
curl -s localhost:9901/listeners
```

The listeners and their addresses. A missing one means it failed to bind or never warmed up. Check the log.

```sh
curl -s localhost:9901/config_dump > envoy-config.json
```

Everything Envoy runs now, including routes and clusters pushed by xDS. Look for `dynamic_warming_clusters`: a cluster stuck there never became ready. It is large, so save it and search.

```sh
curl -s localhost:9901/certs
```

The certificates Envoy has loaded, with their expiry. An expired one here explains handshake failures that the file on disk would not.

```sh changes
curl -s -X POST 'localhost:9901/logging?level=debug'
```

Raises every logger to debug at runtime. It is noisy: set it back with `level=info`. Use `/logging?http=debug` to raise only one logger, and `curl -s -X POST localhost:9901/logging` to list the levels.

```sh changes
curl -s -X POST localhost:9901/healthcheck/fail
```

Makes Envoy's health check endpoint fail, so an external load balancer drains it before you stop it. It needs the health check filter configured. A GET returns 405: the admin POST endpoints reject GET.

### Envoy log lines and response flags

```text
[2026-11-20T16:18:09.336Z] "GET /slow HTTP/1.1" 504 UT 0 24 1004 - "-" "curl/8.5.0" "e607f262-5b28-4a69-a20c-3d12fae84577" "app.example.com:10000" "10.0.0.5:8081"
```

The default access log: method, path, protocol, **status**, **response flags**, bytes in, bytes out, duration in ms, upstream time, then forwarded-for, user agent, request id, authority and the **upstream host**. A dash for the upstream host means no host was ever picked.

```text
UT
```

The upstream did not respond in time: the route's `timeout`, 15 seconds by default. The client sees a 504 with the body "upstream request timeout".

```text
UF
```

Could not connect to the upstream. The 503 body says "upstream connect error or disconnect/reset before headers. reset reason: remote connection failure" and adds "Connection refused" or a timeout.

```text
UC
```

The upstream closed the connection before sending headers: a 503 with "reset reason: connection termination". Often a keep-alive race: the upstream's idle timeout is shorter than Envoy's.

```text
UH
```

A 503 with the body "no healthy upstream": the cluster has no host that Envoy considers healthy. Check `/clusters`. Below 50% healthy hosts Envoy enters panic mode and sends to all hosts, so `UH` usually means the cluster has no hosts at all, or panic mode is turned off.

```text
NR
```

A 404: no route matched the host and path. Check the virtual host `domains` and the route prefixes, and the order of the routes.

```text
URX
```

The retry policy ran out of attempts, or its retry budget, and the last attempt failed. The status is the last upstream's. Look at `upstream_rq_retry` in the stats.

```text
UR
```

A 503: the upstream reset the stream, usually before sending headers. The body ends "reset reason: remote reset". Look at the upstream's log for a crash or a limit.

```text
UO
```

The circuit breaker tripped: too many pending requests or connections to the cluster. A 503 and `upstream_rq_pending_overflow` rising. Raise the limit or fix the slow upstream.

```text
DC
```

The downstream client closed the connection before the response was complete. A client timeout shorter than the response time, or a user who closed the page.

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
408 Request Timeout
```

The client was too slow to send its request. HAProxy logs it as `cR`, nginx as 408 after `client_header_timeout` or `client_body_timeout`. A few from idle pre-connections are normal.

```text
421 Misdirected Request
```

An HTTP/2 connection was reused for a host that its certificate or server does not cover. Seen when two sites share one wildcard or IP. Fix the certificate or stop the connection reuse.

```text
429 Too Many Requests
```

Rate limited, by you or by an upstream. Honour Retry-After.

```text
431 Request Header Fields Too Large
```

The header block is over the server's limit. Node answers 431; HAProxy and nginx answer 400. Reduce cookies, or raise the limit.

```text
496 and 497
```

nginx only. 496: a client certificate was required and not sent (the client sees a 400 page). 497: a plain HTTP request reached an HTTPS port.

```text
460
```

AWS Application Load Balancer: the client closed the connection before the target answered (`target_processing_time` -1 in the log). The client's timeout is shorter than the target's response time: raise it, or make the target answer sooner.

```text
521, 522, 524
```

Cloudflare origin errors. 521: the origin refused the connection. 522: the connect to the origin timed out. 524: the origin accepted but took longer than 100 seconds to answer.

```text
ERR_TOO_MANY_REDIRECTS
```

A redirect loop, shown by curl as exit 47, "Maximum (50) redirects followed". Often TLS ends at the load balancer and the app redirects HTTP to HTTPS because it never saw `X-Forwarded-Proto`.

```text
WebSocket drops after exactly 60 seconds
```

nginx closes an idle upgraded connection after `proxy_read_timeout`. Raise it for that location, or send pings. Without `proxy_http_version 1.1;`, `proxy_set_header Upgrade $http_upgrade` and `Connection "upgrade"` it fails at once.

### nginx error log

```text
connect() failed (111: Connection refused) while connecting to upstream
```

Nothing listens at the upstream address.

```text
upstream timed out (110: Connection timed out)
```

A slow upstream, or packets to it dropped. The text after it says whether it was connecting or reading the response header.

```text
upstream prematurely closed connection
```

The app died mid-request, or closed a keep-alive connection nginx was reusing.

```text
recv() failed (104: Connection reset by peer) while reading response header from upstream
```

The upstream sent a RST: it crashed, hit its own limit, or a firewall dropped the flow. Compare the time with the app's log.

```text
upstream sent invalid header: "this\x20..." while reading response header from upstream
```

The response is not valid HTTP: a debug page or a banner from the wrong service, or a plain TCP service behind `proxy_pass`. Hit the upstream directly with `curl -v`.

```text
upstream sent too big header while reading response header from upstream
```

The response headers do not fit `proxy_buffer_size`. Large cookies or headers from the app. Raise `proxy_buffer_size` and `proxy_buffers`.

```text
no live upstreams
```

Every server in the upstream block is marked failed (`max_fails` within `fail_timeout`).

```text
upstream server temporarily disabled while connecting to upstream
```

One server failed `max_fails` times and is skipped for `fail_timeout`. Several of these in a row end in "no live upstreams".

```text
(13: Permission denied) while connecting to upstream
```

SELinux stops nginx from opening connections. Confirm with `ausearch -m avc -ts recent`. `setsebool -P httpd_can_network_connect 1` fixes it by letting every web server process connect to any port, and `-P` keeps that across reboots: a wide change to the policy, so make it on purpose.

```text
limiting requests, excess: 0.989 by zone "z"
```

A `limit_req` zone refused a request, with a 503 by default. Set `limit_req_status 429` so clients can tell it from an outage, and use `burst`.

```text
client intended to send too large body: 5000 bytes
```

The request body is over `client_max_body_size`: a 413 to the client.

```text
host not found in upstream "app.example.com:8081"
```

nginx could not resolve the upstream name at startup, so it will not start. A name in `proxy_pass` is resolved once at load: use a `resolver` and a variable to resolve it at request time.

```text
open() "/srv/app/missing" failed (2: No such file or directory)
```

A static file is missing, or `root` and `alias` point to the wrong directory. The path is exactly what nginx tried.

### HTTP/2 and gRPC

```sh
curl -sI --http2 https://HOST/ | head -1
```

"HTTP/2 200" means HTTP/2 was negotiated. "HTTP/1.1 200 OK" means the server or a proxy in the path chose HTTP/1.1. Compare with `--http1.1` when you suspect HTTP/2.

```sh
curl --http2-prior-knowledge -s -o /dev/null -w '%{http_version}\n' http://HOST:PORT/
```

Speaks HTTP/2 over plain TCP, as gRPC and many internal proxies do. It prints 2 when the port accepts it. A TLS-terminating proxy with HTTP/2 enabled on its upstream side needs this on the backend.

```text
curl: (92) HTTP/2 stream 1 was not closed cleanly: PROTOCOL_ERROR (err 1)
```

The server or a proxy broke the HTTP/2 rules: an invalid header, a wrong content length, an oversized header block. Retry with `--http1.1`: if that works, capture with `--trace-ascii -` and look at the headers.

```text
curl: (92) HTTP/2 stream 1 was not closed cleanly: INTERNAL_ERROR (err 2)
```

The server side failed on this stream, usually a crash or a limit in the proxy. Check its log at that second.

```text
curl: (92) HTTP/2 stream 1 was not closed cleanly: HTTP_1_1_REQUIRED (err 13)
```

The server refuses HTTP/2 for this request: a feature such as renegotiation or a client certificate that HTTP/2 does not allow. Use `--http1.1`.

```text
curl: (16) Error in the HTTP2 framing layer
```

A frame arrived that curl could not parse: a proxy mangling the connection, or a non-HTTP/2 service answering on an HTTP/2 port.

```text
ERR_HTTP2_PROTOCOL_ERROR
```

The browser's version of the stream errors above. Reproduce with `curl --http2 -v`, then look for a response that disagrees with its `Content-Length`, a duplicated or malformed header, or a proxy that downgrades the protocol.

### Three rules that prevent the strange ones

- **Keep-alive.** The backend's idle timeout must be longer than the proxy's or the load balancer's. Otherwise the proxy reuses a socket the backend has closed and you get random 502s. Node's `keepAliveTimeout` defaults to 5 s; an AWS ALB keeps idle connections for 60 s.
- **Timeouts shrink inward.** Client, then load balancer, proxy, app and the database's `statement_timeout`, each shorter than the one outside it. The innermost layer then fails first and reports the real cause.
- **Retry at one layer.** Only idempotent requests, with backoff and jitter. Three layers making three attempts each turn one failure into 27 requests.

### Idle and request timeouts to compare, hop by hop

- **nginx.** `keepalive_timeout` 75 s toward clients (the stock Docker config sets 65 s); `proxy_read_timeout` 60 s toward the upstream. In an `upstream` block, `keepalive_timeout` is the idle time for reused upstream connections, 60 s by default.
- **HAProxy.** No default for `timeout client`, `timeout server` or `timeout connect`: a config without them warns, and those timeouts then do not exist. `timeout http-keep-alive` is the idle time between requests on one connection.
- **Envoy.** A route `timeout` of 15 s, a stream idle timeout of 5 minutes, and a connection idle timeout of 1 hour, all configurable.
- **Apps.** Node `keepAliveTimeout` 5 s. gunicorn `--keep-alive` 2 s. Tomcat's `keepAliveTimeout` follows its `connectionTimeout`, 20 s. A proxy with a longer idle time than the app gets 502s.
- **Check it.** Send one request, wait a little longer than each hop's idle time, send another on the same connection, and look for the first hop that answers 502 or resets.

## Containers and Kubernetes

The container's exit code and the pod's Events answer most questions before any log does.

### Docker

```sh
docker ps -a --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
```

Status shows exit codes ("Exited (137) 2 minutes ago"); Ports shows what is published to the host.

```sh
docker logs -t --since 10m CTR
```

The container's stdout and stderr with timestamps.

```sh
docker inspect -f '{{.State.ExitCode}} oom={{.State.OOMKilled}} {{.State.Error}}' CTR
```

Why it stopped. `oom=true` is the memory limit.

```sh
docker inspect -f '{{.State.Health.Status}} streak={{.State.Health.FailingStreak}}' CTR
```

The result of the image's or run's health check: **starting**, **healthy** or **unhealthy**, and how many checks in a row failed. It fails with a template error when the container has no health check. `docker inspect CTR | grep -A8 '"Log"'` shows the last check outputs.

```sh
docker stats --no-stream
```

CPU, memory against its limit, network and block IO per container.

```sh
docker top CTR
```

The processes inside, as the host sees them. A PID 1 that is a shell wrapper and not your app means signals never reach the app, so `docker stop` waits 10 seconds and then kills it.

```sh
docker port CTR
```

What is published. No output means nothing is: the container is reachable only from its own network.

```sh
docker events --since 30m --filter container=CTR
```

The recent lifecycle: **create**, **start**, **die** (with the exit code), **oom**, **health_status**. Easier than logs for "why did it restart".

```sh
docker info | grep -E 'Storage Driver|Cgroup (Driver|Version)|Docker Root Dir'
```

The storage driver, cgroup version, and where images and volumes live. Disk full on that path stops every container.

```sh changes
docker run --rm -it --network container:CTR nicolaka/netshoot
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

```text
Exited (125)
```

Docker itself failed before the container started: a bad flag, a name already in use, or a daemon error. The message is on the terminal that ran `docker run`, not in `docker logs`.

```text
Exited (126)
```

The command was found but cannot run: not executable, or a directory. Check the file mode and the image's `ENTRYPOINT`.

```text
Exited (127)
```

Command not found, or a script with Windows line endings (`/bin/sh^M`). Check the path in the image, and a shell-less image such as distroless.

```text
Exited (137)
```

Killed by SIGKILL. With `oom=true` it is the memory limit; without, a `docker kill`, or a `docker stop` that timed out and escalated.

```text
Exited (139)
```

Segmentation fault (SIGSEGV). A native crash, often a library built for another libc such as a glibc binary on Alpine. Check for a core dump and the image's base.

```text
Exited (143)
```

SIGTERM: a normal stop that the app handled by exiting. Not an error.

### kubectl

```sh
kubectl get pods -A -o wide
```

READY, STATUS, RESTARTS and the node, cluster-wide. Restarts above 0 deserve a look.

```sh
kubectl get pods -A --field-selector=status.phase!=Running,status.phase!=Succeeded
```

Pods in phase Pending, Failed or Unknown. A CrashLoopBackOff or not-Ready pod is still phase Running and is not listed: check READY and RESTARTS in `get pods -A`.

```sh
kubectl get pods -A --sort-by='.status.containerStatuses[0].restartCount'
```

Sorted by restarts of the first container: the worst is last.

```sh
kubectl describe pod POD
```

The Events at the bottom say why: scheduling, image pulls, failed probes, OOM.

```sh
kubectl logs POD -c CTR --previous
```

Logs of the instance that crashed, not the fresh one.

```sh
kubectl get pod POD -o jsonpath='{range .status.containerStatuses[*]}{.name}{" "}{.lastState.terminated.reason}{" exit="}{.lastState.terminated.exitCode}{"\n"}{end}'
```

How each container last ended: **OOMKilled**, **Error** or **Completed**, with the exit code. It is the quickest answer to "why does it restart".

```sh
kubectl get events -A --sort-by=.lastTimestamp | tail -30
```

The cluster's recent story across every namespace.

```sh
kubectl get events -A --field-selector type!=Normal --sort-by=.lastTimestamp
```

Warnings only. Events live for about an hour, so read them soon after the failure.

```sh
kubectl events --for pod/POD --types=Warning
```

The Events of one object. Needs kubectl 1.26 or later (**k8s1.26+**).

```sh
kubectl get endpointslices -l kubernetes.io/service-name=SVC
```

Empty: no pod matches the Service selector, or the Service has no selector.

```sh
kubectl get endpointslices -l kubernetes.io/service-name=SVC -o jsonpath='{range .items[*].endpoints[*]}{.addresses[0]}{" ready="}{.conditions.ready}{"\n"}{end}'
```

Each endpoint and whether it is Ready. `ready=false` is a pod failing its readiness probe: it is listed but gets no traffic.

```sh changes
kubectl debug -it POD --image=nicolaka/netshoot --target=CTR
```

An ephemeral debug container that shares the target's process namespace.

```sh changes
kubectl run dns --rm -it --restart=Never --image=busybox:1.36 -- nslookup SVC.NS.svc.cluster.local
```

Cluster DNS, tested from inside a pod. Use the full name: busybox does not apply the search path the way glibc does.

```sh
kubectl port-forward svc/SVC 8080:80
```

Reaches the Service directly, skipping the ingress. Tells you which side is broken. It picks one pod behind the Service and stays on it, with no load balancing, and it stops when that pod goes away.

```sh
kubectl top pod -A --sort-by=memory
```

Live usage. Needs metrics-server; without it you get "Metrics API not available".

```sh changes
kubectl rollout undo deploy/APP
```

Back to the previous ReplicaSet. `kubectl rollout history deploy/APP` lists them.

```sh
kubectl rollout status deploy/APP --timeout=120s; echo "exit $?"
```

Waits for the rollout. Exit 1 after the timeout means it is stuck: new pods are not Ready. Good as a CI gate, and then `describe` the new ReplicaSet's pods.

```sh
kubectl auth can-i --list --as=system:serviceaccount:NS:SA -n NS
```

What a service account may do, for "forbidden" errors.

### Nodes and pressure

```sh
kubectl get nodes -o wide
```

STATUS, the kubelet version, the OS and the container runtime. **NotReady** or **SchedulingDisabled** (cordoned) shows here.

```sh
kubectl get node NODE -o jsonpath='{range .status.conditions[*]}{.type}{"="}{.status}{" "}{.reason}{"\n"}{end}'
```

The node conditions. **Ready=True** is good. **MemoryPressure**, **DiskPressure** and **PIDPressure** should be False. Ready=Unknown means the kubelet stopped reporting.

```sh
kubectl describe node NODE
```

Conditions, taints, **Allocated resources** (requests against capacity) and the Events. A node full of requests is Pending pods with "Insufficient cpu", even with idle CPUs.

```sh
kubectl get lease -n kube-node-lease NODE -o jsonpath='{.spec.renewTime}{"\n"}'
```

The kubelet's heartbeat. A renew time older than a minute with the node still listed means the kubelet is down or cannot reach the API server.

```sh
kubectl get nodes -o custom-columns=Node:.metadata.name,Taints:.spec.taints[*].key
```

The taints per node. The node controller adds `node.kubernetes.io/not-ready` and `unreachable`, and pods tolerate them for 300 seconds by default before eviction.

```sh changes
kubectl cordon NODE
```

Marks the node unschedulable. Running pods stay. `kubectl uncordon NODE` undoes it.

```sh danger
kubectl drain NODE --ignore-daemonsets --delete-emptydir-data
```

Cordons, then evicts the pods, which a controller recreates elsewhere. It deletes `emptyDir` data, and a PodDisruptionBudget can make it wait: add `--dry-run=client` to see the plan first.

```sh changes
kubectl debug node/NODE -it --image=busybox:1.36
```

A pod on the node with the host filesystem at `/host`. Reach the host's logs there without SSH. Delete the debug pod afterwards.

```sh
systemctl is-active kubelet containerd; journalctl -u kubelet --since '15 min ago' --no-pager | tail -30
```

On the node itself: the two services, then the kubelet's recent log. It names failed mounts, probes, evictions and certificate errors.

```text
evictionHard: memory.available<100Mi, nodefs.available<10%, imagefs.available<15%, nodefs.inodesFree<5%
```

The kubelet's default hard eviction thresholds. Below one, the kubelet evicts pods (BestEffort first, then Burstable above their requests) and sets a pressure condition. Check `/var/lib/kubelet/config.yaml` for the real values.

### Probes and restarts

```text
Liveness probe failed: HTTP probe failed with statuscode: 500
```

Liveness failed, so the kubelet kills the container and starts it again. The status code or error after it is what the probe saw. Look for **Killing** and "will be restarted" in the Events.

```text
Readiness probe failed: Get "http://10.244.0.5:8080/ready": dial tcp 10.244.0.5:8080: connect: connection refused
```

The app is not listening yet, or on another port or interface. The pod runs but takes no traffic. For a slow start use a `startupProbe`, not a long `initialDelaySeconds`.

```text
Startup probe failed: ...
```

The container did not become healthy within `failureThreshold` times `periodSeconds`. The kubelet kills it. Raise the threshold: the budget is the product.

```text
CrashLoopBackOff, Last State: Terminated, Reason: Completed, Exit Code: 0
```

Exit 0 with restarts: the command finishes (a script, a daemon that forks into the background) and `restartPolicy: Always` starts it again. Run it in the foreground. A liveness kill usually shows **Error** with 137 or 143.

```text
Back-off restarting failed container
```

The delay between restarts doubles from 10 seconds to 5 minutes. Do not wait for it: read `logs --previous`.

### Memory and CPU limits

```sh
kubectl get pod POD -o jsonpath='{.status.qosClass}{"\n"}'
```

**Guaranteed**, **Burstable** or **BestEffort**. BestEffort is evicted first under node pressure; Guaranteed last.

```sh
kubectl exec POD -c CTR -- sh -c 'cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory.current'
```

The container's memory limit in bytes (`max` means none) and current use, on cgroup v2. A `current` near `max` includes reclaimable page cache. `grep -E '^(anon|file) ' /sys/fs/cgroup/memory.stat` shows how much is real use. On cgroup v1 the files are `/sys/fs/cgroup/memory/memory.limit_in_bytes` and `memory.usage_in_bytes`.

```sh
kubectl exec POD -c CTR -- grep -E 'oom|oom_kill' /sys/fs/cgroup/memory.events
```

**oom_kill** counts processes the kernel killed in this cgroup. On cgroup v2 the kubelet kills the whole container on any OOM (`memory.oom.group`), so a count above 0 goes with a restart.

```sh
kubectl exec POD -c CTR -- sh -c 'cat /sys/fs/cgroup/cpu.max; grep -E "nr_throttled|throttled_usec" /sys/fs/cgroup/cpu.stat'
```

The CPU limit as quota and period (`100000 100000` is one core), and how often the container was throttled. A high **nr_throttled** is a slow app with a CPU limit that is too low, with the node idle.

```sh
sudo dmesg -T | grep -iE 'memory cgroup out of memory|oom-kill|killed process'
```

On the node: the kernel's record of an OOM kill, with the process, its memory and the cgroup. **constraint=CONSTRAINT_MEMCG** means the cgroup limit, not the node running out.

### Image pulls

```text
Failed to pull image "app:v2": rpc error: code = NotFound desc = failed to pull and unpack image "docker.io/library/app:v2": not found
```

The tag does not exist in the registry. Typo, an unpushed build, or a tag from another registry. Check with `crictl pull` on the node.

```text
Failed to pull image "...": dial tcp: lookup registry.example.com: no such host
```

The node cannot resolve the registry name. Node DNS, not cluster DNS: check the node's `/etc/resolv.conf`.

```text
pull access denied, repository does not exist or may require authorization
```

A private image with no credentials, or a wrong name. Check `imagePullSecrets` on the pod or its service account, and that the secret is in the same namespace.

```text
toomanyrequests: You have reached your pull rate limit
```

The registry's anonymous pull limit. Authenticate, or mirror the image into your own registry.

```text
x509: certificate signed by unknown authority
```

The registry uses a certificate the node does not trust. Add the CA to the node's runtime config, not to the pod.

```text
no match for platform in manifest: not found
```

The image has no build for the node's CPU architecture, for example arm64 only on an amd64 node. Check with `docker buildx imagetools inspect IMAGE` and build a multi-arch image.

```text
InvalidImageName
```

The image reference is malformed: a capital letter in the repository, a space, or an empty tag from an unset variable. Fix the manifest.

```text
ErrImageNeverPull
```

`imagePullPolicy: Never` and the image is not on the node. Load or pull it first, or change the policy.

```sh changes
kubectl create secret generic regcred -n NS --type=kubernetes.io/dockerconfigjson --from-file=.dockerconfigjson=FILE
```

A pull secret built from a Docker `config.json`, so no password appears on the command line. Reference it in `imagePullSecrets`. The file holds credentials: delete the copy afterwards.

```sh
sudo crictl images | head; sudo crictl info | grep -iE 'sandboxImage|runtimeType' | head -3
```

On the node: the images the runtime holds. The runtime caches by digest, so with `imagePullPolicy: IfNotPresent` a mutable tag that moved is still the old image on nodes that already pulled it.

### Volumes and PVCs

```sh
kubectl get pvc,pv -A
```

**Bound** is good. **Pending** is waiting for a volume or a first pod. **Lost** means its volume is gone.

```sh
kubectl describe pvc PVCNAME -n NS
```

The Events say why a claim is stuck: no StorageClass, a provisioner that failed, or "waiting for first consumer".

```sh
kubectl get storageclass
```

The classes, which one is **(default)**, the **VOLUMEBINDINGMODE** and the reclaim policy. A PVC with no `storageClassName` and no default class stays Pending for ever.

```text
waiting for first consumer to be created before binding
```

Normal with `WaitForFirstConsumer`: the volume is created when a pod uses the claim. If the pod is Pending too, fix the pod first.

```text
0/3 nodes are available: 3 pod has unbound immediate PersistentVolumeClaims.
```

The pod waits for a claim that never bound. Fix the PVC: StorageClass, provisioner, or a PV that matches its size and access mode.

```text
Warning  ProvisioningFailed  ... failed to provision volume with StorageClass "standard": ...
```

The provisioner's reason follows: a quota, a wrong zone, missing cloud permissions. Read the provisioner's pod log in `kube-system`.

```text
MountVolume.SetUp failed for volume "cfg" : configmap "app-config" not found
```

The pod references a ConfigMap or Secret that is missing, in this namespace. It stays in **ContainerCreating** until the object exists.

```text
Multi-Attach error for volume "pvc-..." Volume is already exclusively attached to one node and can't be attached to another
```

A ReadWriteOnce volume is still attached to the old node. Wait for the detach, or find the old pod; `kubectl get volumeattachments` shows where it is attached.

```sh
kubectl get pvc PVCNAME -n NS -o jsonpath='{.metadata.finalizers}{"\n"}'
```

A claim stuck in **Terminating** with `kubernetes.io/pvc-protection` is still used by a pod. Delete the pod first, and do not remove the finalizer.

### Services, Ingress and DNS

```sh
kubectl describe svc SVC -n NS
```

The selector, the port and **targetPort**, and **Endpoints**. `<none>` there is the first thing to fix: the selector or the readiness.

```sh
kubectl get pods -n NS --show-labels
```

Compare the labels with the Service's selector. Pods listed but not Ready give an empty endpoint list; no pods at all means the selector and the pod labels disagree.

```text
curl: (7) Failed to connect to SVC port 80 after 0 ms: Couldn't connect to server
```

A Service with no ready endpoints refuses at once. Older curl says `Connection refused`. A timeout instead means packets are dropped on the way: a NetworkPolicy or a node firewall.

```sh
kubectl get ingressclass; kubectl get ingress -A
```

The classes, then each Ingress with its class, hosts and address. An empty **ADDRESS** means no controller has picked it up: the `ingressClassName` is wrong or the controller is down.

```sh
kubectl describe ingress INGNAME -n NS
```

Rules and backends. `<error: services "x" not found>` means the backend Service name is wrong or in another namespace; the controller then answers 503 or 404.

```sh
kubectl get configmap coredns -n kube-system -o jsonpath='{.data.Corefile}'
```

The cluster DNS config: the `kubernetes` zone, the `forward` line for outside names, and plugins such as `loop` and `cache`.

```sh
kubectl logs -n kube-system -l k8s-app=kube-dns --tail=30
```

CoreDNS errors. `[ERROR] plugin/errors: 2 api.example.com. A: read udp ...: i/o timeout` means its upstream resolver is unreachable.

```text
[FATAL] plugin/loop: Loop (127.0.0.1:55953 -> :53) detected for zone ".", see https://coredns.io/plugins/loop#troubleshooting
```

CoreDNS forwards to a resolver that points back at CoreDNS, usually a node `/etc/resolv.conf` with `127.0.0.53`. Point `forward` at a real upstream.

```sh
kubectl exec POD -- cat /etc/resolv.conf
```

The pod's resolver: the `nameserver` is the kube-dns Service IP, **search** lists `NS.svc.cluster.local`, and `options ndots:5`. A wrong nameserver here means the pod's `dnsPolicy` is not what you think.

```sh
kubectl get pods -n kube-system -l k8s-app=kube-dns -o wide
```

CoreDNS pods and their nodes. If every pod is down, everything in the cluster that uses a name fails together.

### NetworkPolicy

```sh
kubectl get networkpolicy -A
```

Policies per namespace. A pod selected by any policy denies all traffic of the listed types that no rule allows.

```sh
kubectl describe networkpolicy POLNAME -n NS
```

The selected pods, and the allowed sources and ports. A policy with an empty `ingress: []` is deny-all. A namespace selector needs the namespace to carry that label.

```text
connection times out between two pods, Service works from another namespace
```

The pattern of a NetworkPolicy drop: a timeout, not a refusal. Test from the allowed side. The CNI must enforce policies: some, such as plain flannel, ignore them silently.

### RBAC

```text
Error from server (Forbidden): pods is forbidden: User "system:serviceaccount:app:runner" cannot list resource "pods" in API group "" in the namespace "app"
```

The message names who, what verb, what resource and where. Add a Role and a RoleBinding for exactly that, rather than cluster-admin.

```sh
kubectl auth can-i list pods --as=system:serviceaccount:NS:SA -n NS
```

Prints **yes** or **no** for one verb and resource. Needs the right to impersonate.

```sh
kubectl auth whoami
```

Who the API server thinks you are, with groups. Needs kubectl 1.28 or later (**k8s1.28+**).

```sh
kubectl get rolebindings,clusterrolebindings -A -o wide | grep -w SA
```

Bindings that name the service account. No line means no direct binding; it may still get rights through a group. Run `kubectl auth can-i --list` as that account for the full picture.

```text
exceeded quota: q, requested: pods=1, used: pods=50, limited: pods=50
```

A ResourceQuota in the namespace blocks the create. `kubectl describe quota -n NS` shows the use. Raise the quota or free resources.

### crictl on the node

```sh
sudo crictl ps -a --name CTR
```

Containers as the runtime sees them, with state and attempt number. Works when the API server is down. If it fails with "unix:///var/run/dockershim.sock", set `CONTAINER_RUNTIME_ENDPOINT=unix:///run/containerd/containerd.sock`.

```sh
sudo crictl logs --tail 50 ID
```

A container's log by ID, without kubectl. ID is the first column of `crictl ps -a`.

```sh
sudo crictl inspect ID | grep -E '"(reason|exitCode|startedAt|finishedAt)"'
```

How and when the container ended: **reason** (`OOMKilled`, `Error`, `Completed`) and the exit code.

```sh
sudo crictl stats; sudo crictl pods
```

Per-container CPU and memory, and the pod sandboxes. A sandbox in a bad state means the CNI or runtime failed before any container started.

```sh changes
sudo crictl pull IMAGE
```

Pulls an image the way the kubelet would, with the node's own DNS, proxy and CA. It reproduces a pull failure with the full error.

```text
validate service connection: ... connection refused
```

crictl cannot reach the runtime socket: containerd is down, or the endpoint is wrong. Check `systemctl status containerd` and `/etc/crictl.yaml`.

### Control plane, etcd and certificates

```sh
kubectl get --raw='/readyz?verbose' 2>&1 | grep -v ' ok$'
```

Only the failing checks, such as `[-]etcd failed`, or `readyz check passed`. A failure comes back as an HTTP 500 error that holds the whole list. `/livez?verbose` is the liveness equivalent.

```sh
kubectl get pods -n kube-system -o wide
```

The control-plane pods (`kube-apiserver`, `etcd`, `kube-scheduler`, `kube-controller-manager`) and CoreDNS. On kubeadm clusters they are static pods, restarted by the kubelet from `/etc/kubernetes/manifests`.

```sh
kubectl -n kube-system exec etcd-NODE -- etcdctl --endpoints=https://127.0.0.1:2379 --cacert=/etc/kubernetes/pki/etcd/ca.crt --cert=/etc/kubernetes/pki/etcd/server.crt --key=/etc/kubernetes/pki/etcd/server.key endpoint health
```

Is etcd answering. The paths are the kubeadm defaults. Use `endpoint status -w table` for the DB size and leader, `alarm list` for a **NOSPACE** alarm, and `member list` for the members.

```text
etcdserver: mvcc: database space exceeded
```

etcd hit its size quota (2 GiB by default) and went read-only. Compact and defragment, then clear the alarm with `etcdctl alarm disarm`. Find what wrote so much: often events or a runaway controller.

```text
etcdserver: request timed out
```

etcd is slow, nearly always from its disk. Check `etcd_disk_wal_fsync_duration_seconds` and use a fast local disk.

```sh
sudo kubeadm certs check-expiration
```

Every control-plane certificate with its expiry and days left. kubeadm certificates last one year unless upgraded. The CAs last ten years.

```sh
sudo openssl x509 -in /etc/kubernetes/pki/apiserver.crt -noout -enddate
```

The same check without kubeadm, for one file. A cluster whose certificates expired gives `x509: certificate has expired or is not yet valid` on every `kubectl`.

```sh
kubectl config view --raw --minify -o jsonpath='{.users[0].user.client-certificate-data}' | base64 -d | openssl x509 -noout -enddate
```

When your own client certificate in the kubeconfig expires. The output holds a public certificate only, not the key. This works only for embedded data: for a `client-certificate` file path run `openssl x509` on that file; token and exec users have no client certificate.

```sh danger
sudo kubeadm certs renew all
```

Renews every kubeadm-managed certificate. Run it on every control-plane node: it renews that node's files only. Then restart each static pod: move its manifest out of `/etc/kubernetes/manifests`, wait 20 seconds for the pod to stop, and move it back. Copy the new `admin.conf` for kubectl. Take an etcd snapshot first.

```sh
sudo grep -E 'rotateCertificates|serverTLSBootstrap' /var/lib/kubelet/config.yaml; sudo ls /var/lib/kubelet/pki
```

Whether the kubelet rotates its own client certificate, and the files it holds. Rotation is on by default in kubeadm clusters.

```text
The connection to the server localhost:8080 was refused - did you specify the right host or port?
```

kubectl found no kubeconfig and used its default. Set `KUBECONFIG` or `~/.kube/config`.

```text
Unable to connect to the server: dial tcp 192.168.1.10:6443: connect: connection refused
```

The API server is not listening at that address: the control-plane pod is down, or you hit the wrong address. On the node, `sudo crictl ps -a --name kube-apiserver` says why.

```text
Unable to connect to the server: net/http: TLS handshake timeout
```

The API server is overloaded or etcd is slow, or a firewall or proxy sits on the path. Try `curl -k https://HOST:6443/livez`.

### More pod states and errors

```text
Pending
```

Cannot be scheduled. `describe` says why: Insufficient cpu or memory (requests too big), taints, node selectors, an unbound PVC.

```text
0/3 nodes are available: 1 node(s) had untolerated taint {node-role.kubernetes.io/control-plane: }, 2 Insufficient memory.
```

The scheduler's count per reason. Reduce requests, add a node, or add a toleration for the taint. `didn't match Pod's node affinity/selector` means a label is missing on every node.

```text
ContainerCreating
```

The image is pulled or the sandbox is being built. Stuck for minutes: look at the Events for a failed mount (`MountVolume.SetUp failed`) or a CNI error (`Failed to create pod sandbox`, often `failed to setup network for sandbox`).

```text
Init:0/2
```

The first of two init containers has not finished. Read its logs with `kubectl logs POD -c CTR`. `Init:Error` and `Init:CrashLoopBackOff` mean an init container failed, and the main containers never start.

```text
ImagePullBackOff
```

Wrong image name or tag, or a private registry without imagePullSecrets. **ErrImagePull** is the attempt that failed a moment ago, and ImagePullBackOff the wait before the next. On kind, load the image with `kind load docker-image IMAGE` and avoid `:latest`, which forces a pull.

```text
CrashLoopBackOff
```

The process keeps exiting. Read `logs --previous`, then the command, args, env and mounted config. A liveness probe killing a slow starter looks the same: add a startupProbe.

```text
OOMKilled
```

The container hit its memory limit (exit 137). Raise the limit or fix the leak; size JVM or V8 heaps below it. Verify with the cgroup `memory.events` file above.

```text
Error
```

The container exited non-zero. `kubectl describe pod` shows the exit code. 1 or 2 is the app, 126 or 127 is the command, 137 is a kill, 139 a segmentation fault.

```text
RunContainerError
```

The runtime could not start the container: a command that does not exist in the image, a bad mount, a security context the node refuses. The Events carry the runtime's message.

```text
CreateContainerConfigError
```

A referenced Secret, ConfigMap or key does not exist.

```text
couldn't find key DB_URL in Secret app/db
```

The Secret exists but lacks that key. `kubectl describe secret db -n app` lists its keys and sizes, without the values.

```text
Running, READY 0/1
```

The readiness probe fails, so the pod is out of its Service and gets no traffic.

```text
Completed
```

The container finished with exit 0. Normal for a Job. For a Deployment it means the command exits when it should run for ever.

```text
ContainerStatusUnknown
```

The kubelet lost track of the container, often after the node ran out of disk or memory, or was rebooted. Delete the pod; its controller recreates it.

```text
Evicted
```

The node ran short of memory or disk. `kubectl describe node` shows its pressure conditions. The message gives the resource, for example "The node was low on resource: ephemeral-storage".

```sh changes
kubectl delete pods -A --field-selector=status.phase=Failed
```

Clears Evicted and other failed pods in every namespace. They are records only. Their logs go with them. Look at the message of one first.

```text
Terminating, forever
```

A finalizer is waiting, or the node is gone. Check `.metadata.finalizers`. Force-delete only when you know the node is dead: a StatefulSet can end up with two pods.

```sh danger
kubectl patch pod POD -n NS --type=merge -p '{"metadata":{"finalizers":null}}'
```

Removes the finalizers, so the object is deleted without its cleanup. The owner of the finalizer, such as a storage or controller, never gets to release what it holds. Last resort, after you know what the finalizer was for.

```text
Ingress returns 503 or 404
```

503: the Service has no ready endpoints. 404: no host or path rule matches, or the wrong `ingressClassName`.

```text
external DNS slow in pods
```

`ndots:5` makes every external name try each search domain first. Use a trailing dot (`api.example.com.`) or lower ndots in `dnsConfig`.

```text
Error from server (BadRequest): container "c" in pod "p" is waiting to start: ContainerCreating
```

`kubectl logs` on a container that has not started. There is nothing to read yet: use `describe` and the Events.

```text
error: unable to upgrade connection: container not found ("c")
```

`kubectl exec` into a container that has crashed or been replaced. Retry when it is Running, or use `kubectl debug`.

```text
error: Metrics API not available
```

metrics-server is not installed or not Ready. `kubectl top` needs it: check `kubectl get apiservice v1beta1.metrics.k8s.io`.

## Cloud: AWS, Google Cloud, Azure

What usually breaks in a cloud account: the CLI is signed in as the wrong identity, an instance fails a status check, a load balancer marks every target unhealthy, a firewall rule blocks a port, or a quota stops a launch. Run these from a terminal with read access; the changing commands are tagged.

### Who am I

```sh
aws sts get-caller-identity
```

The account, the user or role ARN and the user id the CLI is acting as. Run it first: a wrong profile, region or assumed role explains most "it works on my machine" cloud errors.

```sh
aws configure list
```

Where the CLI found its profile, keys and region: the **Type** column reads `env`, `shared-credentials-file`, `sso` or `iam-role`. Environment variables win over the profile you thought you chose.

```sh
gcloud auth list
gcloud config list
```

The active account is marked with `*`. `config list` shows the default project, region and zone every command will use. With no account it prints "No credentialed accounts."

```sh
az account show
```

The subscription, tenant and signed-in user. A command that finds nothing is often run against the wrong subscription: list them with `az account list -o table` and switch with `az account set --subscription` and its name or id.

### AWS: instances and load balancers

```sh
aws ec2 describe-instances --instance-ids INSTANCE --region REGION --query 'Reservations[].Instances[].[InstanceId,State.Name,StateReason.Message]' --output text
```

The state (`pending`, `running`, `stopping`, `stopped`, `terminated`) and, for a stop you did not ask for, the reason such as `Client.InstanceInitiatedShutdown` or `Server.SpotInstanceTermination`.

```sh
aws ec2 describe-instance-status --instance-ids INSTANCE --include-all-instances --region REGION --query 'InstanceStatuses[].[InstanceState.Name,SystemStatus.Status,InstanceStatus.Status]' --output text
```

Two status checks. **SystemStatus** impaired: the AWS host failed, so stop and start the instance to move it. A stop loses instance-store data and, without an Elastic IP, the public IPv4 address. **InstanceStatus** impaired: the guest OS is unreachable, so read the console output. Without `--include-all-instances`, stopped instances are left out.

```sh
aws ec2 get-console-output --instance-id INSTANCE --latest --output text --region REGION
```

The last console output, as the serial console saw it: kernel panics, a failed mount in `fstab`, cloud-init errors. Output lags by a few minutes.

```sh
aws elbv2 describe-target-groups --load-balancer-arn ARN --region REGION
```

The target groups behind a load balancer, with the health check path, port and thresholds. Compare the health check path and port with what the app really serves.

```sh
aws elbv2 describe-target-health --target-group-arn ARN --region REGION --query 'TargetHealthDescriptions[].[Target.Id,TargetHealth.State,TargetHealth.Reason]' --output text
```

**State** `unhealthy` with Reason `Target.ResponseCodeMismatch`, `Target.Timeout` or `Target.FailedHealthChecks`: the app answered wrongly or not at all. State `unused` with `Target.NotInUse`: no listener rule forwards to the group, or the target's zone is not enabled on the load balancer. `Target.NotRegistered`: the target is not in this group.

```sh
aws ec2 describe-instances --instance-ids INSTANCE --region REGION --query 'Reservations[].Instances[].SecurityGroups[].GroupId' --output text
aws ec2 describe-security-groups --group-ids SGID --region REGION --query 'SecurityGroups[].IpPermissions'
```

The security groups on an instance, then their inbound rules. Security groups only allow: no match means dropped, which a client sees as a timeout. Also check the subnet's network ACL, which has deny rules.

```sh
aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=StopInstances --max-results 5 --region REGION
```

Who stopped something and when: each event has a **Username** and a time. Swap in `TerminateInstances`, `AuthorizeSecurityGroupIngress` or `ModifyInstanceAttribute`. Events appear a few minutes late.

```sh
aws health describe-events --region us-east-1 --filter eventStatusCodes=open
```

Open AWS Health events for your account. It needs a Business, Enterprise On-Ramp or Enterprise support plan, otherwise it fails with `SubscriptionRequiredException`. Without one, read the public status page below.

```sh changes
aws ec2 reboot-instances --instance-ids INSTANCE --region REGION
```

Reboots the guest OS on the same host; it keeps the instance id, addresses and disks. An instance that fails the system status check needs a stop and start instead, which loses instance-store data and, without an Elastic IP, the public IPv4 address.

### AWS: quotas and limits

```sh
aws service-quotas get-service-quota --service-code ec2 --quota-code L-1216C47A --region REGION
```

The applied value of "Running On-Demand Standard instances", counted in vCPUs, not instances. Compare it with your usage before a launch fails with `VcpuLimitExceeded`. Quotas are per region.

```sh
aws service-quotas list-service-quotas --service-code ec2 --region REGION --query 'Quotas[?contains(QuotaName, `Running On-Demand`)].[QuotaName,QuotaCode,Value]' --output text
```

Every On-Demand vCPU quota by instance family, with its code for `get-service-quota`. Request an increase in the Service Quotas console or with `aws service-quotas request-service-quota-increase`.

### Google Cloud

```sh
gcloud compute instances list --filter="status!=RUNNING"
```

Every instance in the default project that is not running: `TERMINATED`, `STOPPING`, `SUSPENDED` or `STAGING`. A `TERMINATED` instance you did not stop was preempted or crashed: check the operations list.

```sh
gcloud compute instances describe INSTANCE --zone ZONE --format="value(status,statusMessage)"
```

The state, plus a message when the platform stopped the instance. Add `--format=yaml` for the whole resource: scheduling, network interfaces, service account and metadata.

```sh
gcloud compute instances get-serial-port-output INSTANCE --zone ZONE --start=0
```

The serial console log: boot messages, kernel panics, startup script output. Works with no SSH and no network. `--start` is a byte offset, so re-run with the last offset to read only new output.

```sh
gcloud compute backend-services get-health BACKEND --global
```

Health of every backend of a global load balancer, per instance group: `HEALTHY` or `UNHEALTHY`. Use `--region REGION` for a regional one. All unhealthy usually means the health check probe range is blocked: see the firewall entry below.

```sh
gcloud compute firewall-rules list --sort-by=priority
```

Rules with their direction, priority, ranges and allowed protocols. Lowest priority number wins. The VPC denies ingress by default, so a load balancer's health checks need an allow rule for Google's published probe ranges.

```sh
gcloud compute instances network-interfaces get-effective-firewalls INSTANCE --zone ZONE
```

The firewall rules that really apply to one instance, after policies and inheritance. Use it when the rule list looks right but traffic is still dropped.

```sh
gcloud compute regions describe REGION --format="yaml(quotas)"
```

Per-region quotas, each with `limit`, `usage` and `metric`: `CPUS`, `IN_USE_ADDRESSES`, `SSD_TOTAL_GB`. A metric where usage equals the limit is the one blocking creates. Project-wide quotas: `gcloud compute project-info describe --format="yaml(quotas)"`.

```sh
gcloud compute operations list --filter="status!=DONE OR error:*" --sort-by=~insertTime --limit=20
```

Compute operations still pending or running, and recent ones that failed (a failed one is still `DONE`, with `error` set): live migrations, stops, preemptions.

```sh danger
gcloud compute instances reset INSTANCE --zone ZONE
```

A hard reset, like the power button on a server: no clean shutdown, so open files and database writes can be lost. The instance keeps its disks and IPs. Use `gcloud compute instances stop` and `start` when a clean stop works; a stop releases an ephemeral external IP.

### Azure

```sh
az vm list -g RGNAME -d -o table
```

Every VM in a resource group with its **PowerState** (`VM running`, `VM deallocated`, `VM stopped`) and addresses. A `VM stopped` machine is still billed; only `deallocated` releases compute.

```sh
az vm get-instance-view -g RGNAME -n INSTANCE --query "instanceView.statuses[].displayStatus" -o tsv
```

Provisioning and power state in plain words, such as `Provisioning succeeded` and `VM running`. A `Provisioning failed` line is followed by the reason in the activity log.

```sh
az vm boot-diagnostics get-boot-log -g RGNAME -n INSTANCE
```

The serial console log of the VM. It needs boot diagnostics enabled on the VM. Look for kernel panics, a stuck `fstab` mount and cloud-init errors.

```sh
az network application-gateway show-backend-health -g RGNAME -n GATEWAY
```

Health of each backend server of an Application Gateway: `Healthy`, `Unhealthy` or `Unknown`, with a log message. For a Standard Load Balancer there is no such command: watch the `DipAvailability` metric in `az monitor metrics list`.

```sh
az network nsg rule list -g RGNAME --nsg-name NSGNAME -o table
```

Rules with priority, direction, access and port ranges. The lowest priority number is evaluated first. The built-in default rules, priority 65000 and above, do not show here: add `--include-default`.

```sh
az network nic list-effective-nsg -g RGNAME -n NICNAME
```

The rules in force on one network interface, merged from the subnet's and the NIC's security groups. The VM must be running. Find the NIC with `az vm show -g RGNAME -n INSTANCE --query networkProfile`.

```sh
az vm list-usage --location REGION -o table
```

**CurrentValue** against **Limit** for regional vCPUs and per-family vCPUs. A row at its limit blocks the next create or resize. Raise it from the portal, under Usage + quotas.

```sh
az vm list-skus --location REGION --size Standard_D2s_v5 --all --query "[].{name:name,restrictions:restrictions}"
```

A row with `restrictions: []` means the size is sold in that region. No row means the name is wrong or not offered there. `NotAvailableForSubscription` or a zone restriction explains a `SkuNotAvailable` error: pick another size or zone, or ask support.

```sh
az monitor activity-log list --offset 1h -g RGNAME --status Failed
```

Failed control-plane operations from the last hour, with the caller and the error message. The activity log is where a failed VM create or an `AuthorizationFailed` shows up first.

```sh changes
az vm restart -g RGNAME -n INSTANCE
```

A graceful restart: the OS shuts down and starts again on the same host, with its disks and IPs. To move to a new host, use `az vm redeploy`, which wipes the temporary disk.

### Instance metadata, from inside the VM

```sh
TOKEN=$(curl -s -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')
curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/instance-id
```

AWS IMDSv2: a session token first, then every read sends it. A `401` means the token is missing or expired. Other paths: `instance-type`, `placement/availability-zone`, `iam/security-credentials/` (the role name only; the name after it returns live keys, so do not paste it).

```sh
curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/spot/instance-action
```

Empty with a `404` on a normal Spot instance. Once AWS decides to reclaim it, the body holds the action and the time, giving about two minutes' warning. Poll every 5 seconds from a drain script.

```sh changes
aws ec2 modify-instance-metadata-options --instance-id INSTANCE --http-put-response-hop-limit 2 --region REGION
```

A container on the instance gets no answer from the metadata address when the hop limit is 1: the token reply dies one hop short. Setting it to 2 fixes that. Adding `--http-tokens required` enforces IMDSv2 and breaks clients still on IMDSv1: check the `MetadataNoToken` CloudWatch metric first.

```sh
curl -s -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/zone
```

GCE metadata needs the `Metadata-Flavor: Google` header; without it the server answers `403`. Other paths: `instance/name`, `instance/service-accounts/default/email`, `project/project-id`. `169.254.169.254` also answers.

```sh
curl -s -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/preempted
curl -s -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/maintenance-event
```

`TRUE` or `FALSE` for a Spot or preemptible VM, and `NONE` or a maintenance event such as `MIGRATE_ON_HOST_MAINTENANCE` or `TERMINATE_ON_HOST_MAINTENANCE`. Add `?wait_for_change=true` to block until the value changes.

```sh
curl -s -H 'Metadata:true' --noproxy '*' 'http://169.254.169.254/metadata/instance?api-version=2021-02-01'
```

Azure IMDS: the `Metadata:true` header is required, and the request must bypass any proxy, so `--noproxy`. Fields: `compute.vmSize`, `compute.zone`, `compute.resourceGroupName`, `network.interface`.

```sh
curl -s -H 'Metadata:true' --noproxy '*' 'http://169.254.169.254/metadata/scheduledevents?api-version=2020-07-01'
```

Planned maintenance for this VM: `Reboot`, `Redeploy`, `Freeze`, `Preempt` or `Terminate`, each with a **NotBefore** time. An empty `Events` list means nothing is planned.

### Service health

- AWS: [Health Dashboard](https://health.aws.amazon.com/health/status) for public events. Events for your own resources are in the same console, signed in.
- Google Cloud: [Status dashboard](https://status.cloud.google.com/) for public incidents. Personalized Service Health in the console lists the ones that touch your projects.
- Azure: [Azure status](https://azure.status.microsoft/) for public incidents. Service Health in the portal lists the ones that touch your subscriptions.

### Cloud CLI errors

```text
An error occurred (ExpiredToken) when calling the GetCallerIdentity operation: The security token included in the request is expired
```

Temporary credentials (an assumed role, SSO or an instance role session) ran out. Get new ones: `aws sso login` or re-assume the role. Stale `AWS_SESSION_TOKEN` in the environment keeps failing after you fix the profile: unset it.

```text
The SSO session associated with this profile has expired or is otherwise invalid. To refresh this SSO session run aws sso login with the corresponding profile.
```

The cached SSO login is gone. Run `aws sso login` with the same `--profile` in a terminal with a browser, or add `--use-device-code` over SSH.

```text
An error occurred (AccessDenied) when calling the ListBuckets operation: User: arn:aws:iam::123456789012:user/ops is not authorized to perform: s3:ListAllMyBuckets because no identity-based policy allows the s3:ListAllMyBuckets action
```

The **ending** names the layer that denied it. "because no identity-based policy allows": add an Allow. "with an explicit deny in a service control policy": an Organizations guardrail, ask the org admin. "permissions boundary", "session policy" and "resource-based policy" read the same way.

```text
An error occurred (UnauthorizedOperation) when calling the RunInstances operation: You are not authorized to perform this operation. User: arn:aws:iam::123456789012:user/ops is not authorized to perform: ec2:RunInstances ... Encoded authorization failure message: ENCODED
```

EC2 hides the reason in the encoded message. Decode it with `aws sts decode-authorization-message --encoded-message ENCODED --query DecodedMessage --output text`. That needs the `sts:DecodeAuthorizationMessage` permission.

```text
An error occurred (RequestLimitExceeded) when calling the DescribeInstances operation (reached max retries: 2): Request limit exceeded.
```

EC2 throttled your account's API calls: a loop, a monitoring agent or several tools polling. Other services say `ThrottlingException` or `Throttling` with "Rate exceeded". Back off, and set `AWS_RETRY_MODE=adaptive` and `AWS_MAX_ATTEMPTS=10`.

```text
An error occurred (InsufficientInstanceCapacity) when calling the RunInstances operation (reached max retries: 2): We currently do not have sufficient m5.large capacity in the Availability Zone you requested
```

AWS has no spare hardware of that type in that zone right now. Retry later, pick another zone or instance type, or omit the zone. A stopped instance may fail to start for the same reason: try a different type.

```text
An error occurred (VcpuLimitExceeded) when calling the RunInstances operation: You have requested more vCPU capacity than your current vCPU limit of 0 allows for the instance bucket that the specified instance type belongs to.
```

A quota, not capacity: the account's vCPU limit for that instance family. `InstanceLimitExceeded` and `MaxSpotInstanceCountExceeded` are the older and Spot versions. Check with `get-service-quota`, then request an increase.

```text
ERROR: (gcloud.compute.instances.list) You do not currently have an active account selected.
```

No signed-in account. Run `gcloud auth login`, or `gcloud auth activate-service-account` with a key file for automation. `gcloud auth list` shows what is stored.

```text
ERROR: (gcloud.compute.instances.create) Could not fetch resource:
 - Quota 'CPUS' exceeded.  Limit: 24.0 in region us-central1.
```

A project quota is full: the quoted metric, limit and region say which. Compare with `gcloud compute regions describe REGION`. Delete idle instances or request an increase in IAM and Admin, Quotas.

```text
The zone 'projects/PROJECT_ID/zones/ZONE' does not have enough resources available to fulfill the request.
```

Google's `ZONE_RESOURCE_POOL_EXHAUSTED`: no capacity of that machine type in that zone. Try another zone or machine type, or retry later. A reservation holds capacity in advance.

```text
ERROR: Please run 'az login' to setup account.
```

The Azure CLI has no valid session, or its token expired. Run `az login`, or `az login --use-device-code` over SSH. For automation, sign in with a service principal or a managed identity.

```text
The client '...' with object id '...' does not have authorization to perform action 'Microsoft.Compute/virtualMachines/read' over scope '...' or the scope is invalid. If access was recently granted, please refresh your credentials.
```

The role assignment is missing at that scope, or the scope is mistyped, often the wrong subscription. The **action** names the permission to grant. A new assignment can take a few minutes: `az logout` and `az login` refreshes the token.

```text
The requested size for resource '...' is currently not available in location '...' zones '...' for subscription '...'. Please try another size or deploy to a different location or zones.
```

Azure's `SkuNotAvailable`: that VM size is restricted for your subscription in that region or zone. List the restrictions with `az vm list-skus`, then pick another size or zone.

```text
Operation could not be completed as it results in exceeding approved standardDSv5Family Cores quota. Additional details - Deployment Model: Resource Manager, Location: eastus, Current Limit: 10, Current Usage: 8, Additional Required: 4, (Minimum) New Limit Required: 12.
```

A vCPU quota is full in that region, for one VM family or for the regional total. **Current Limit** and **Current Usage** are the numbers from `az vm list-usage`. File a quota request in the portal under Usage + quotas.

## App runtimes: JVM, Node.js, Python, Go

What breaks inside the process: a heap that fills, threads stuck on a lock, a loop that pins a core, or a limit set from the host instead of the container. Take a thread or goroutine dump first; a restart throws the evidence away.

### JVM

```sh
jcmd
```

Lists the running JVMs with their process id and main class. Run it as the same user as the JVM, and in the same container: a JVM from another user or mount namespace does not show up.

```sh
jcmd PID Thread.print
```

A thread dump. Look at each thread's `java.lang.Thread.State`: many `BLOCKED` threads waiting on the same lock, or `RUNNABLE` threads in the same method, show the bottleneck. Take three dumps, five seconds apart, to see what does not move. Deadlocks are reported at the end. `jstack PID` is the older name.

```sh changes
kill -3 PID
```

Asks the JVM to print a thread dump to its own stdout (the container log), without stopping it. Use it when there is no `jcmd`, for example in a JRE-only image. The JVM does not exit.

```sh
jcmd PID GC.heap_info
```

Heap by generation: **used** against **total** per space, and Metaspace. Old generation (`tenured` or `old`) at 90 percent or more after a collection means a leak or a heap that is too small.

```sh
jstat -gcutil PID 1000 5
```

A GC sample every second, five times. **O** is old-generation percent used, **YGC** and **FGC** the young and full collection counts, **GCT** total GC seconds. O stuck near 100 with FGC climbing: the JVM is about to throw an OutOfMemoryError.

```sh
jcmd PID GC.class_histogram | head -20
```

The classes using the most heap, by instances and bytes. It forces a full collection first (the GC log says "Heap Inspection Initiated GC"), so expect a pause on a big heap. The top entry is usually the leak: `[B` is `byte[]`, `[C` is `char[]`.

```sh changes
jcmd PID GC.heap_dump FILE
```

Writes a heap dump (hprof) for Eclipse MAT or VisualVM. It pauses the JVM for the duration, and the file is about the size of the live heap. FILE must be writable by the JVM's user, and the dump holds every secret in memory: guard it.

```sh
jcmd PID VM.native_memory summary
```

Native memory by category: Java Heap, Class, Thread, Code, GC, Internal. It only works if the JVM started with `-XX:NativeMemoryTracking=summary`; otherwise it says "Native memory tracking is not enabled". Use it when RSS far exceeds the heap. `baseline` then `summary.diff` shows growth.

```sh changes
jcmd PID JFR.start name=triage duration=60s filename=/tmp/triage.jfr
```

Starts a Java Flight Recorder recording, about 1 percent overhead, that stops by itself. Read it with `jfr summary /tmp/triage.jfr` or `jfr print --events jdk.ExecutionSample /tmp/triage.jfr`. Check with `jcmd PID JFR.check`; dump a running one with `JFR.dump`.

```sh
jcmd PID VM.flags
jcmd PID VM.command_line
```

The flags the JVM really runs with, including the ergonomic ones: **MaxHeapSize**, the collector in use, and every `-X` option. Read these before changing any: a JAVA_TOOL_OPTIONS in the environment shows here too.

```sh
java -XX:+PrintFlagsFinal -version | grep -E 'MaxHeapSize|MaxRAMPercentage|UseSerialGC|UseG1GC'
```

What a fresh JVM picks on this host or container. In a 512 MiB container it chose a 128 MiB heap (**MaxRAMPercentage** defaults to 25) and the Serial collector, because the JVM treats under 1792 MB or fewer than 2 CPUs as a small machine. A `-Xmx` overrides the percentage.

```sh
java -XX:MaxRAMPercentage=75 -XX:+ExitOnOutOfMemoryError -XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/tmp -jar app.jar
```

The container-aware sizing: the heap is 75 percent of the container limit, which leaves room for Metaspace, thread stacks and buffers. A heap near 100 percent of the limit gets the container OOM-killed with no Java error. The last two flags write a dump on failure, then exit so the orchestrator restarts it.

```sh
java -Xlog:gc*,safepoint:file=/var/log/app/gc.log:time,uptime,level,tags:filecount=5,filesize=20m -jar app.jar
```

A rotating unified GC log (JDK 9 and later; the old `-XX:+PrintGCDetails` is gone). Read the **Pause** lines: pauses over a second, or "Pause Full" repeating, mean GC is the bottleneck. The directory must exist and be writable.

```sh
ps -o nlwp= -p PID
```

The thread count of a process. A count that grows without bound is a thread leak and ends in "unable to create native thread". Compare with `cat /sys/fs/cgroup/pids.max` in a container (cgroup v2).

### JVM errors

```text
Exception in thread "main" java.lang.OutOfMemoryError: Java heap space
```

The heap is full and a collection could not free enough. A leak (heap dump, then the histogram) or a heap smaller than the load needs (`-Xmx` or `MaxRAMPercentage`). The stack under it is only where the last allocation failed, not the cause.

```text
Exception in thread "main" java.lang.OutOfMemoryError: Metaspace
```

Class metadata filled `-XX:MaxMetaspaceSize`. A classloader leak, usually from redeploys, or code generating classes without end (proxies, scripting). Count loaders with `jcmd PID VM.classloader_stats`. Metaspace is native memory, not the heap.

```text
Exception in thread "main" java.lang.OutOfMemoryError: unable to create native thread: possibly out of memory or process/resource limits reached
```

The OS refused a new thread: not the heap. Check the thread count (`ps -o nlwp=`), the container's `pids.max`, `ulimit -u` and free native memory. The usual cause is a pool with no upper bound. The JVM can stay up afterwards, with its other threads still running.

```text
Exception in thread "main" java.lang.OutOfMemoryError: GC overhead limit exceeded
```

The Parallel collector spent almost all its time in GC and freed under 2 percent of the heap. It is a leak or an undersized heap that took a long way to fail. Treat it like "Java heap space".

```text
Terminating due to java.lang.OutOfMemoryError: Java heap space
```

`-XX:+ExitOnOutOfMemoryError` fired: the JVM exits at the first OutOfMemoryError, so the supervisor can restart it. A heap dump written before the exit (`HeapDumpOnOutOfMemoryError`) is the evidence.

```text
Exception in thread "main" java.lang.StackOverflowError
```

Recursion without an end, or a very deep call chain. The repeated frames at the top of the trace name the loop. Fix the recursion first; `-Xss` makes a bigger stack per thread but only delays it.

### Node.js

```sh
node --inspect=127.0.0.1:9229 app.js
```

Starts the V8 inspector: the process prints "Debugger listening on ws://127.0.0.1:9229/..." and Chrome DevTools attaches at `chrome://inspect`. Keep it on loopback and reach it through an SSH tunnel. The inspector has no authentication, so `0.0.0.0` hands out remote code execution.

```sh changes
kill -USR1 PID
```

Turns the inspector on in a running Node process, listening on 127.0.0.1:9229, with no restart. Check with `curl -s http://127.0.0.1:9229/json/list`. It stays on until the process exits.

```sh
node --heapsnapshot-signal=SIGUSR2 app.js
```

Writes a heap snapshot (`Heap.*.heapsnapshot` in the working directory) each time the process gets `kill -USR2 PID`. Load it in the DevTools Memory tab and compare two snapshots. The process pauses while it writes, and a big heap needs about as much free memory again.

```sh
node --max-old-space-size=64 --heapsnapshot-near-heap-limit=1 app.js
```

Writes a snapshot just before the heap limit is hit, so a crash that nobody could catch leaves evidence. The snapshot itself needs memory, so give a margin. Use a larger value than 64, which is only for a test.

```sh
node -e "console.log(require('v8').getHeapStatistics().heap_size_limit / 1048576)"
```

The heap limit in MB that Node picked on this host. In a 512 MiB container it printed 259. Change it with `--max-old-space-size=MB` or `NODE_OPTIONS=--max-old-space-size=MB`; keep it below the container limit, because buffers and native memory sit outside the heap.

```sh changes
kill -USR2 PID
```

With `--report-on-signal` set at start, this writes a diagnostic report (a JSON file named `report.*.json`): JavaScript and native stacks, heap statistics, libuv handles, environment. It needs no inspector and works on a stuck process. The report can contain environment variables. Without that flag, USR2 kills the process: check `ps -o args= -p PID` first.

```sh
node -e "const h=require('perf_hooks').monitorEventLoopDelay({resolution:20});h.enable();setInterval(()=>{console.log('p99 ms',h.percentile(99)/1e6,'max ms',h.max/1e6);h.reset()},5000)"
```

Event loop delay, as p99 and max in ms. Paste the first two statements and the `setInterval` into the app or a `--require` file; run on its own it just prints zeros. Under 20 ms is healthy; hundreds of ms means a synchronous call, a big JSON parse or a CPU loop blocks every request.

```sh
node --cpu-prof --cpu-prof-dir=/tmp/prof app.js
```

Writes a `.cpuprofile` when the process exits. Open it in the DevTools Performance tab, or load it in a flame graph viewer. For a running process, record from the inspector instead.

```sh
node --trace-gc app.js
```

Prints a line per collection: `Scavenge` (young) or `Mark-Compact` (old), heap before and after, and the pause in ms. Mark-Compact running every second with the heap barely shrinking is a leak.

### Node.js errors

```text
FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
```

The old space reached `--max-old-space-size` and a collection did not help. Above it, the "Last few GCs" lines show Mark-Compact freeing almost nothing: a leak. Take snapshots over time, or raise the limit if the working set really grew. Node aborts, so a supervisor must restart it.

```text
[UnhandledPromiseRejection: This error originated either by throwing inside of an async function without a catch block, or by rejecting a promise which was not handled with .catch(). The promise rejected with the reason "plain string".] { code: 'ERR_UNHANDLED_REJECTION' }
```

Since Node 15 an unhandled rejection kills the process. This text appears when the reason is not an Error; with an Error, Node prints its stack instead. Find the async call with no `await` or `.catch()`. `--unhandled-rejections=warn` keeps the process alive; use it only as a stopgap.

```text
Error: listen EADDRINUSE: address already in use :::3000
```

Another process, often the previous instance that did not exit, holds the port. Find it with `ss -tlnp 'sport = :3000'`. The code is `EADDRINUSE`.

```text
Error: connect ECONNREFUSED 127.0.0.1:3999
```

The target host answered with a reset: nothing listens on that address and port. In a container, `localhost` is the container itself, not the host or the database service. Check the service name and port.

```text
Error: read ECONNRESET
```

The peer closed the connection abruptly while you were using it: an idle timeout on a load balancer, a crashed server, or a keep-alive connection reused after the server dropped it. For HTTP clients it often shows as `socket hang up`. Retry idempotent calls, and keep the client's keep-alive shorter than the server's.

```text
RangeError: Maximum call stack size exceeded
```

Recursion without an end, or a very large `apply` or spread of an array. The trace shows the same function repeating. It is a normal, catchable error in the process, not a crash.

### Python

```sh
py-spy dump --pid PID
```

Every thread's current stack without editing the program, like a thread dump. `active+gil` is the thread running Python code; `idle` threads wait. By default it pauses the process while it reads the stacks; add `--nonblocking` to never pause it, at the cost of an occasional torn stack. It needs ptrace rights: run it as the same user or root. Add `--locals` for variable values. Install: `pip install py-spy`.

```sh
py-spy top --pid PID
```

A live view of where the time goes by function, like `top`. It pauses the process for every sample, 100 a second by default: add `--nonblocking` on a busy production process. It needs a terminal: in a container use `docker exec -it`. Without a terminal it fails with "Not a tty".

```sh
py-spy record --pid PID --duration 30 --format raw -o /tmp/py.txt
```

Samples for 30 seconds into folded stacks (one per line, with a count), ready for a flame graph tool. Like `top`, it pauses the process for every sample unless you add `--nonblocking`. Leave `--format raw` out to write an SVG flame graph. The heaviest stacks are on the lines with the largest numbers.

```sh
PYTHONFAULTHANDLER=1 python app.py
```

Turns on `faulthandler`: a crash from a segfault, an abort or a C extension prints every thread's Python stack to stderr, "Fatal Python error: Segmentation fault". In code, `faulthandler.register(signal.SIGUSR1)` dumps all stacks on `kill -USR1 PID`, and `faulthandler.dump_traceback_later(30, repeat=True)` dumps a hung process on a timer.

```sh
python -X tracemalloc=5 app.py
```

Tracks every allocation with 5 frames of stack; it costs memory and speed, so use it in a test. In code, `tracemalloc.take_snapshot().statistics('lineno')[:5]` prints lines such as `app.py:3: size=19.9 MiB, count=20001, average=1042 B`. Compare two snapshots with `snapshot.compare_to(old, 'lineno')`.

```sh
PYTHONUNBUFFERED=1 python app.py
```

Stdout and stderr are written at once, not in blocks. Without it, a Python process in a container or a pipe can look silent for minutes while its logs sit in a buffer. Use `python -u` for the same effect.

```sh
python -c "import sys; print(sys.getrecursionlimit())"
```

The recursion limit, 1000 by default. A RecursionError needs real recursion or a cycle, so raise it only for a known deep structure, with `sys.setrecursionlimit`.

### Python errors

```text
RecursionError: maximum recursion depth exceeded
```

A function calls itself without a stop, or two call each other. The traceback shows "[Previous line repeated 996 more times]" and the repeated frame is the loop. Fix the base case; raising the limit only moves the crash.

```text
MemoryError
```

An allocation failed: the process hit its address-space or memory limit (`ulimit -v`, a container limit) or the host is out of memory. Often a huge list, a file read whole or a big `bytes` object. Under a cgroup limit the kernel usually kills the process instead (exit 137, "Killed"), with no Python error.

```text
BrokenPipeError: [Errno 32] Broken pipe
```

Writing to a pipe whose reader has gone, as in `python app.py | head -1`, or a client that closed a socket before the reply. A script piped to `head` can ignore it; in a server, it means the client left. Python raises it only at write time.

```text
OSError: [Errno 24] Too many open files: '/etc/passwd'
```

The process hit its file-descriptor limit: leaked files, sockets or connections not closed. Count them with `ls /proc/PID/fd | wc -l`, compare with `ulimit -n` and `grep 'open files' /proc/PID/limits`, and close with `with` blocks.

```text
Fatal Python error: Segmentation fault
```

A crash in C code: a native extension, `ctypes` or the interpreter. With `faulthandler` on, the Python stack follows ("most recent call first"), and its top line is the Python call that went into C. Update the extension, or reproduce under `gdb`.

```text
Error: Failed to find python version from target process
```

py-spy attached to a process that is not a Python interpreter: often the shell that started it (`sh -c 'python app.py'`) or a wrapper. Find the real PID with `pgrep -a python`. In a container, start with `exec python` so it is PID 1.

```text
Error: Permission denied (os error 13)
```

py-spy lacks the right to attach. Run it as root or the process's user. In Docker, start the container with `--cap-add SYS_PTRACE`; with a system-wide Yama setting, `kernel.yama.ptrace_scope` set to 1 or higher blocks attaching to non-children.

### Go

```sh
curl -s 'http://127.0.0.1:6060/debug/pprof/goroutine?debug=1' | head -30
```

Goroutines grouped by identical stack: the count at the start of each group, then the frames. The first line says `goroutine profile: total N`. One stack with thousands of goroutines is a leak, usually blocked on a channel or a lock nobody releases. It needs `import _ "net/http/pprof"` and a server on that port. Keep it on loopback: pprof exposes internals.

```sh
curl -s 'http://127.0.0.1:6060/debug/pprof/goroutine?debug=2' | head -60
```

Every goroutine with its full stack and state, in the same shape as a crash dump: `goroutine 98 [running]:`, `[chan receive]`, `[select (no cases)]`, `[IO wait]`, `[sync.Mutex.Lock]`. A goroutine blocked a long time shows it, as in `[chan receive, 5 minutes]`. With many goroutines it pauses the program briefly.

```sh
go tool pprof -top -nodecount=15 'http://127.0.0.1:6060/debug/pprof/profile?seconds=30'
```

A 30-second CPU profile, ranked: **flat** is time in the function itself, **cum** includes what it calls. The sample total tells you how busy it was. `runtime.asyncPreempt` near the top is just a busy loop. Add `-http=:8081` for the flame graph. Profiling costs a few percent of CPU for the 30 seconds.

```sh
go tool pprof -top -sample_index=inuse_space -nodecount=15 http://127.0.0.1:6060/debug/pprof/heap
```

Live heap by function: **inuse_space** is what is held now, `alloc_space` all that was allocated. Take two profiles minutes apart and compare with `-base`: the function that grows is the leak. A heap profile shows the state at the last completed collection.

```sh changes
kill -QUIT PID
```

Makes a Go program print every goroutine's stack to stderr, then exit with code 2: "SIGQUIT: quit". That is the dump for a hung process with no pprof, but it ends the process, so supervisors restart it. Read it from the log. A Java process, by contrast, survives `kill -3`.

```sh
GODEBUG=gctrace=1 ./app
```

One line per collection on stderr: `gc 12 @4.2s 3%: ... 18->20->9 MB, 20 MB goal, 8 P`. The percentage is time spent in GC so far; the three sizes are heap at start, at end and live. A live size that rises each cycle is a leak; a high percentage means too much garbage.

```sh
GOMEMLIMIT=400MiB GOMAXPROCS=2 ./app
```

A soft memory limit that makes the collector work harder near it, and the number of OS threads running Go code. Before Go 1.25, GOMAXPROCS is the host's CPU count even in a container with a CPU limit (it printed 8 with `--cpus 2`), so a limited container gets throttled: set it, or use the automaxprocs package. GOMEMLIMIT is soft, so keep it under the container limit.

```sh
GOTRACEBACK=all ./app
```

On a crash, print every goroutine, not only the one that failed. `GOTRACEBACK=crash` also raises SIGABRT for a core dump. The default prints only the failing goroutine (`single`).

```sh
go version -m ./app
```

The Go version a binary was built with, its module path and every dependency version. Use it to see what is actually deployed.

### Go errors

```text
fatal error: concurrent map writes
```

Two goroutines wrote to the same map at once. Unlike a panic, this `fatal error` cannot be recovered; the process dies. Guard the map with `sync.Mutex` or `sync.Map`. Build with `go build -race` to find the lines.

```text
fatal error: concurrent map read and map write
```

The same bug when one goroutine reads while another writes. The trace lists the goroutine that detected it, not every one involved: use the race detector to find the other.

```text
fatal error: all goroutines are asleep - deadlock!
```

Every goroutine is blocked: a channel nobody sends to, a `WaitGroup` never done, a mutex locked twice. Go only detects this when none can run; a deadlock inside a server with timers is silent. The stack below shows what each waits on.

```text
panic: runtime error: invalid memory address or nil pointer dereference
[signal SIGSEGV: segmentation violation code=0x1 addr=0x0 pc=0x466c70]
```

A nil pointer, map or interface was used. `addr=0x0` confirms it. The first frame of the goroutine that follows, under `goroutine 1 [running]:`, is the file and line where it happened.

```text
panic: runtime error: index out of range [5] with length 1
```

A slice or array indexed past its length. The numbers say the index and the length. Find the loop or the caller that computed the index.

```text
panic: close of closed channel
```

A channel closed twice, or closed by two goroutines. Only the sender should close, and once. `panic: send on closed channel` is the sibling: a sender outlived the close.

```text
goroutine 1 [running]:
main.main()
	/src/app/main.go:5 +0x10
exit status 2
```

The shape of every Go panic dump. `goroutine N [state]` is one goroutine; `running` is the one that panicked. Its frames read top-down from the failure to the caller, each with file:line. "created by main.main in goroutine 1" below another goroutine says who started it. Exit status 2 is a panic.

```text
runtime: goroutine stack exceeds 1000000000-byte limit
fatal error: stack overflow
```

Recursion without an end: the 1 GB maximum stack was reached, so the process needs that much memory first and may be OOM-killed before it prints. The repeating frames are the loop.

```text
Killed
```

The shell's word for SIGKILL, exit code 137: in a container, usually the kernel OOM killer, with no Go error at all. `GOMEMLIMIT` is soft and does not prevent it. Check `dmesg -T | grep -i 'out of memory'` and `docker inspect` for `OOMKilled`.

## Message queues

Brokers fail by backing up: a consumer stops, a replica drops out, a disk fills, and the queue grows until producers block. Read the depth and the consumers first, then the broker's own health. Kafka commands are the `kafka-*.sh` scripts in the `bin/` folder of the Apache tarball (KRaft mode, Kafka 3.7 and 4.x); BROKER is a `host:port` that answers, and `--command-config FILE` carries TLS or SASL settings so no password sits on the command line. RabbitMQ commands run on the node (add `-n rabbit@HOST` for another) as the user that owns `.erlang.cookie`; output is from RabbitMQ 4.x.

### Kafka: cluster and controller

```sh
kafka-metadata-quorum.sh --bootstrap-server BROKER describe --status
```

The KRaft controller quorum. **LeaderId** is the active controller, **CurrentVoters** lists every voter, and **MaxFollowerLag** and **MaxFollowerLagTimeMs** should sit near 0. A lag that keeps growing means a voter is down or slow. With a majority of voters down the call itself times out.

```sh
kafka-metadata-quorum.sh --bootstrap-server BROKER describe --replication
```

One row per voter. **Lag** is how many records it is behind the leader; a stale **LastFetchTimestamp** and a rising **Lag** mark the dead voter. **Status** is Leader, Follower or Observer.

```sh
kafka-broker-api-versions.sh --bootstrap-server BROKER | grep 'id:'
```

One line per live broker, such as `localhost:9092 (id: 1 rack: null) -> (`; Kafka 4.0 adds `isFenced: false`. A broker missing from the list is down, unreachable or fenced. Add `| wc -l` to count brokers.

```sh
kafka-features.sh --bootstrap-server BROKER describe
```

**FinalizedVersionLevel** against **SupportedMaxVersion** for `metadata.version` and the other features. After an upgrade a lower finalized level means the new features are still off. Raise it only after every broker runs the new version.

### Kafka: partitions and replicas

```sh
kafka-topics.sh --bootstrap-server BROKER --describe --under-replicated-partitions
```

Empty output is healthy. Each line is a partition whose **Isr** list is shorter than **Replicas**: a follower is down, slow, or its disk is full. A broker log that keeps shrinking and expanding the ISR points to a slow follower (watch `IsrShrinksPerSec` and `IsrExpandsPerSec`). `replica.lag.time.max.ms` sets how long a follower may lag before it leaves.

```sh
kafka-topics.sh --bootstrap-server BROKER --describe --under-min-isr-partitions
```

Partitions with fewer in-sync replicas than `min.insync.replicas`. Producers using `acks=all` get `NotEnoughReplicasException` on these; reads still work. Bring the missing replica back before you lower `min.insync.replicas`.

```sh
kafka-topics.sh --bootstrap-server BROKER --describe --unavailable-partitions
```

Prints only partitions with no leader, because every replica is offline. Empty output means every partition has a leader. These partitions fail both reads and writes.

```sh
kafka-topics.sh --bootstrap-server BROKER --describe --topic TOPIC
```

Per partition: **Leader**, **Replicas** (the first is the preferred leader) and **Isr**. A **Leader** that differs from the first replica is a skew after a restart. Kafka 4.x also prints **Elr** and **LastKnownElr** columns, empty when healthy.

```sh changes
kafka-leader-election.sh --bootstrap-server BROKER --election-type preferred --all-topic-partitions
```

Hands leadership back to each partition's preferred replica, but only where the current leader is not already it. Clients reconnect for a moment. Run it once the stopped broker is back in the ISR.

```sh danger
kafka-leader-election.sh --bootstrap-server BROKER --election-type unclean --topic TOPIC --partition 0
```

Elects a leader that is not in the ISR, only for a partition that has no leader. It can lose acknowledged records and make replicas diverge. Last resort: the usual fix is to bring a broker with the data back.

```sh
kafka-topics.sh --bootstrap-server BROKER --list
```

Topic names, including the internal `__consumer_offsets`. A topic you did not create is usually a client with auto-creation on: see `auto.create.topics.enable`.

### Kafka: consumer groups and lag

```sh
kafka-consumer-groups.sh --bootstrap-server BROKER --list --state
```

Every group with its state: Stable, PreparingRebalance, CompletingRebalance, Empty or Dead. Empty is a group with offsets and no live members. Groups on the 4.x consumer protocol (`group.protocol=consumer`) show Assigning or Reconciling instead of the two rebalance states.

```sh
kafka-consumer-groups.sh --bootstrap-server BROKER --describe --group GROUPNAME
```

Lag per partition is **LOG-END-OFFSET** minus **CURRENT-OFFSET**: a row with `100`, `2822` and `2722` is a group 2722 records behind. A lag that grows while the group has members means slow consumers; a `-` in **CONSUMER-ID** and a first line saying "has no active members" mean nobody is consuming. One partition far above the rest is a hot key or one stuck consumer.

```sh
kafka-consumer-groups.sh --bootstrap-server BROKER --describe --group GROUPNAME --state
```

**STATE**, **#MEMBERS**, the **COORDINATOR (ID)** broker and the **ASSIGNMENT-STRATEGY**. Run it a few times: a group that keeps returning to PreparingRebalance (or Reconciling) is in a rebalance storm.

```sh
kafka-consumer-groups.sh --bootstrap-server BROKER --describe --group GROUPNAME --members
```

One row per member with **CLIENT-ID**, **HOST** and **#PARTITIONS**. A member with 0 partitions is idle because the group has more consumers than partitions. Members whose host you do not recognise are old deployments still running.

```sh
kafka-consumer-groups.sh --bootstrap-server BROKER --describe --all-groups
```

The lag table for every group. Fine for a quick look; on a cluster with hundreds of groups name the group instead, as it asks the coordinator for each one.

```sh
kafka-get-offsets.sh --bootstrap-server BROKER --topic TOPIC
```

Latest offset per partition, as `topic:partition:offset`. Run it twice, a minute apart, to get the produce rate; an offset that never moves means producers are stuck.

### Kafka: resetting offsets

```sh
kafka-consumer-groups.sh --bootstrap-server BROKER --group GROUPNAME --topic TOPIC --reset-offsets --to-earliest --dry-run
```

Prints the **NEW-OFFSET** for each partition and changes nothing; always run it before `--execute`. The group must be Empty, so stop every consumer first. Swap `--to-earliest` for `--to-latest`, `--to-offset N` or `--shift-by -100`; Kafka clamps a shift below the earliest offset to the earliest and warns.

```sh
kafka-consumer-groups.sh --bootstrap-server BROKER --group GROUPNAME --topic TOPIC --reset-offsets --to-datetime 2026-01-01T00:00:00.000 --dry-run
```

Plans a move to the first record at or after that time. An empty partition falls back to the latest offset and prints a `Warn:` line.

```sh changes
kafka-consumer-groups.sh --bootstrap-server BROKER --group GROUPNAME --topic TOPIC --reset-offsets --to-earliest --execute
```

Replays the whole topic for that group. Everything still on disk is processed again, so consumers must tolerate duplicates. Save each partition's **CURRENT-OFFSET** from `--describe` first: to undo, reset each partition back with `--topic TOPIC:PARTITION --to-offset N` (partitions after the colon, comma-separated), or use `--from-file` with a CSV.

```sh danger
kafka-consumer-groups.sh --bootstrap-server BROKER --group GROUPNAME --topic TOPIC --reset-offsets --to-latest --execute
```

Skips the backlog: the group never processes records between its old offset and the end. Use it only when dropping the backlog is acceptable, and save the current offsets from `--describe` first.

```sh danger
kafka-consumer-groups.sh --bootstrap-server BROKER --delete --group GROUPNAME
```

Deletes the group and its committed offsets, so a consumer with the same group id starts from `auto.offset.reset`. The group must be Empty, or you get `GroupNotEmptyException`.

### Kafka: disk, retention and logs

```sh
kafka-log-dirs.sh --bootstrap-server BROKER --describe --topic-list TOPIC
```

JSON per broker and log directory, with each partition's **size** in bytes and **offsetLag** for a replica that is catching up. A log directory whose `error` is not `null` (an exception class name) has gone offline after a disk error.

```sh
df -h MNT; du -sh MNT/* | sort -h | tail -10
```

Free space on the volume named by `log.dirs`, then the ten biggest partition folders (named `topic-partition`). A broker that runs out of space stops serving the log directory, so alert well before 90 percent.

```sh
kafka-configs.sh --bootstrap-server BROKER --entity-type topics --entity-name TOPIC --describe --all | grep -E 'retention|segment|cleanup'
```

The effective `retention.ms`, `retention.bytes`, `segment.bytes` and `cleanup.policy`, each with where it comes from in **synonyms**. Retention deletes only closed segments, so a quiet topic can keep data past its retention until the 1 GiB segment rolls (`segment.ms` forces it).

```sh danger
kafka-configs.sh --bootstrap-server BROKER --entity-type topics --entity-name TOPIC --alter --add-config retention.ms=86400000
```

Sets the topic's retention to one day; older closed segments go on the next retention check, which cannot be undone. Revert the setting with `--alter --delete-config retention.ms`.

```text
[GroupCoordinator id=1 topic=__consumer_offsets partition=43] Preparing to rebalance group g2 in state PreparingRebalance with old generation 1 (reason: Adding new member c-b-be05c4a1 with group instance id null; ...
```

A coordinator log line, one per rebalance, with the **reason**. Count them per minute: repeated lines for one group, each with a new reason, are a storm. Fix the cause (slow `poll()`, `max.poll.interval.ms`, flapping pods, `session.timeout.ms` too low), not the broker.

### Kafka errors

```text
org.apache.kafka.common.errors.RecordTooLargeException: The message is 2000088 bytes when serialized which is larger than 1048576, which is the value of the max.request.size configuration.
```

The record is bigger than the producer's `max.request.size`. The broker has its own limit too: `message.max.bytes`, or `max.message.bytes` on the topic. Raise all of them together, and `fetch.max.bytes` and `max.partition.fetch.bytes` on consumers.

```text
org.apache.kafka.common.errors.NotEnoughReplicasException: Messages are rejected since there are fewer in-sync replicas than required.
```

A write with `acks=all` found fewer in-sync replicas than `min.insync.replicas`. The client logs `NOT_ENOUGH_REPLICAS` and retries first. **Check** `--under-min-isr-partitions` and bring the missing broker back.

```text
org.apache.kafka.common.errors.NotLeaderOrFollowerException
```

The client sent a request to a broker that no longer leads that partition. It is normal for a moment during a leader move or restart, and the client refreshes metadata. If it repeats, check `advertised.listeners`: two brokers advertising the same address (one load balancer, `localhost`) send requests to the wrong broker.

```text
org.apache.kafka.common.errors.TimeoutException: Topic nosuch not present in metadata after 60000 ms.
org.apache.kafka.common.errors.TimeoutException: Expiring 1 record(s) for orders-0:120000 ms has passed since batch creation
```

The first: the producer could not learn the topic's leader within `max.block.ms`, so the topic is missing or the cluster is unreachable. The second: a batch waited longer than `delivery.timeout.ms`, because the leader was down, slow or under min ISR. **Check** broker reachability first.

```text
Call(callName=describeMetadataQuorum, deadlineMs=1795191471869, tries=1, nextAllowedTryMs=1795191472033) timed out at 1795191471931 after 1 attempt(s)
```

An admin tool call timed out, with `DisconnectException ... due to node 1 being disconnected` below it. Seen when two of three controllers were stopped: no quorum, no answers. **Check** every controller with `docker ps` or `systemctl`, then the controller port (9093 by default).

```text
[AdminClient clientId=adminclient-1] Connection to node -1 (localhost/127.0.0.1:9999) could not be established. Node may not be available.
```

The tool cannot open a TCP connection to the bootstrap address, and repeats until its timeout. The address or port is wrong, the broker is down, or a firewall drops it. **Check** `--bootstrap-server` matches a listener, then `nc -vz` to it.

```text
org.apache.kafka.clients.consumer.CommitFailedException: Commit cannot be completed since the group has already rebalanced and assigned the partitions to another member. This means that the time between subsequent calls to poll() was longer than the configured max.poll.interval.ms ...
```

The consumer took too long between `poll()` calls, so the group moved its partitions. Process less per poll (`max.poll.records`), speed up the handler, or raise `max.poll.interval.ms`. Expect duplicates for the uncommitted batch.

```text
org.apache.kafka.common.errors.RebalanceInProgressException: The group is rebalancing, so a rejoin is needed.
```

The group is mid-rebalance, so commits and heartbeats are refused until members rejoin. One is normal after a deploy. If it keeps returning, see the rebalance storm entry: look for members failing their heartbeat.

```text
Error: Assignments can only be reset if the group 'g2' is inactive, but the current state is Stable.
```

A reset needs an Empty group. Stop every consumer (or scale the deployment to 0), wait for `--describe --state` to show Empty, then run the reset again.

```text
Error while executing topic command : Unable to replicate the partition 3 time(s): The target replication factor of 3 cannot be reached because only 1 broker(s) are registered.
```

`InvalidReplicationFactorException`: the topic asks for more replicas than there are live brokers. Lower the factor, or bring the missing brokers back. A broker that is down at creation time gives the same error.

```text
{nosuch-auto=UNKNOWN_TOPIC_OR_PARTITION}
```

Seen in a producer WARN about a recoverable metadata issue: the topic does not exist yet. With `auto.create.topics.enable=true` (the apache/kafka default) the broker then creates it with default partitions, so a typo makes a new topic. Turn auto-creation off in production.

```text
Error while executing topic command : Topic 'orders' already exists.
```

`TopicExistsException`. Run `--describe --topic TOPIC` to see its real settings, and use `kafka-configs.sh --alter` or `kafka-topics.sh --alter --partitions N` to change them. Partitions can only grow.

```text
Group 'nosuch' could not be deleted due to: org.apache.kafka.common.errors.GroupIdNotFoundException: The group id does not exist.
```

The group has no committed offsets or was already deleted. Check the spelling with `--list`. Groups also disappear when `offsets.retention.minutes` (7 days by default) passes after the last member left.

### RabbitMQ: node and cluster health

```sh
rabbitmq-diagnostics ping
```

Only proves the Erlang VM is up and the CLI can talk to it. A node can pass this while the broker app is stopped, so follow with `check_running`.

```sh
rabbitmq-diagnostics check_running
```

Exits non-zero unless the RabbitMQ app is fully booted. After `rabbitmqctl stop_app` it prints "is not running or has not fully booted yet (check with is_booting)". Use it as the liveness probe for the broker itself, not `ping`.

```sh
rabbitmq-diagnostics status
```

Version, uptime, Erlang processes, file descriptors, listeners and memory. Read **Memory high watermark setting** and **Low free disk space watermark**, the two limits that trigger alarms, and compare **Total memory used** with the watermark.

```sh
rabbitmq-diagnostics alarms
```

Lists resource alarms in effect, for example "Memory alarm on node rabbit@rmq1" or "Free disk space alarm on node ...". "reported no alarms, local or clusterwide" means publishers are not blocked. `check_local_alarms` is deprecated and a no-op in 4.x.

```sh
rabbitmq-diagnostics check_alarms
```

Same check, with an exit code: 0 when clean, non-zero (69 seen) while any alarm is in effect. Put it in a monitoring probe.

```sh
rabbitmq-diagnostics memory_breakdown --unit MB
```

Where the node's memory goes, largest first. Look at **queue_procs**, **binary** (message bodies), **connection_readers** and **connection_channels**, **quorum_ets**, **mgmt_db** and **other_proc**. **reserved_unallocated** is memory the runtime holds but is not using.

```sh
rabbitmq-diagnostics listeners
```

Interface, port and protocol of each listener: 5672 for AMQP, 15672 for the management API, 25672 for clustering and CLI, 15692 for Prometheus. A missing line is a listener that failed to bind.

```sh
rabbitmq-diagnostics check_port_connectivity
```

Opens a TCP connection to every listener using the node's hostname. It catches a name that resolves to the wrong address, which `listeners` cannot. Pair it with `check_virtual_hosts`, which confirms every vhost is running.

```sh
rabbitmq-diagnostics cluster_status
```

Disk nodes, running nodes, versions, maintenance status, **Alarms** and **Network Partitions**. A node listed under disk nodes but not under running nodes is down. Any entry under partitions means a split that needs a decision.

```sh
rabbitmq-diagnostics check_if_node_is_quorum_critical
```

Before stopping a node, asks whether any quorum queue or stream would lose its majority. Non-zero means yes: wait for the other replicas to catch up. On a single node it says the check does not apply.

```sh
rabbitmq-queues quorum_status QUEUE
```

A table per replica: **Raft State** (leader or follower), **Membership**, **Last Log Index**, **Last Written**, **Last Applied** and **Commit Index**. A follower whose index trails the leader's by a lot is catching up or stuck. It fails on a classic queue.

```sh rabbitmq4.0.8+
rabbitmq-diagnostics check_for_quorum_queues_without_an_elected_leader --across-all-vhosts '.*'
```

Checks that every quorum queue matching the regular expression has an available leader. A non-zero exit lists the queues without one, usually because a majority of replicas is down. The pattern argument is required.

```sh
rabbitmq-diagnostics check_if_any_deprecated_features_are_used
```

Before a major upgrade: lists features the cluster still uses that the next series removes, such as classic queue mirroring. "Cluster reported no deprecated features in use" is a clean answer.

```sh
rabbitmq-diagnostics check_certificate_expiration
```

Checks every TLS certificate the node loads and warns about any expiring within the window (four weeks by default). "No certificates are expiring within 4 weeks." is clean.

```sh
rabbitmq-diagnostics maybe_stuck
```

Samples Erlang processes for ten seconds and lists suspicious ones. A healthy idle node can still report one (an idle system process), so act only if the stack belongs to a queue or channel. It is slow and noisy: use it when a queue hangs.

### RabbitMQ: queues, consumers and connections

```sh
rabbitmqctl list_queues name type messages messages_ready messages_unacknowledged consumers memory state
```

**messages_ready** is waiting for a consumer; **messages_unacknowledged** is delivered but not acked. Ready growing with `consumers` at 0 means nobody listens. Unacknowledged pinned at the prefetch count (10 here) means a consumer receives but never acks. **state** other than `running` needs a look.

```sh
rabbitmqctl list_queues name consumer_utilisation message_bytes message_bytes_unacknowledged head_message_timestamp
```

**consumer_utilisation** is the share of time a classic queue can deliver; far below 1 means consumers are slow or prefetch is too low. **message_bytes** shows size, not count. **head_message_timestamp** stays empty unless publishers set a timestamp.

```sh
rabbitmqctl list_consumers
```

Each consumer with its **queue_name**, **channel_pid**, **ack_required**, **prefetch_count** and **active**. A queue missing here has no consumer. Several consumers on one queue with `active` false are standby (single active consumer).

```sh
rabbitmqctl list_channels connection name consumer_count messages_unacknowledged prefetch_count
```

Per channel: how many unacknowledged messages it holds against its **prefetch_count**. One channel with a large unacked count is the stuck consumer. Thousands of channels on one connection is a client leak.

```sh
rabbitmqctl list_connections name user state channels peer_host peer_port connected_at
```

**state** is `running`, `blocking` or `blocked`. `blocked` is a publisher the broker has stopped because of an alarm; `blocking` has not published yet. **connected_at** is epoch milliseconds: many very recent values is churn. **user** shows who owns a connection.

```text
closing AMQP connection ([::1]:33690 -> [::1]:5672, duration: '2ms')
```

A broker log line for every closed connection. Many per second with short **duration** values means a client opens a connection for each message. It wastes CPU and file descriptors. Reuse one long-lived connection and a channel per thread.

```sh
curl -s --netrc-file ~/.rabbitmq.netrc 'http://HOST:15672/api/nodes?columns=name,mem_used,mem_limit,mem_alarm,disk_free,disk_free_limit,disk_free_alarm,fd_used,fd_total'
```

Limits and use in one JSON line per node, from the management API. Put `machine HOST`, `login` and `password` lines in `~/.rabbitmq.netrc` (mode 600) so the password never appears in a command. **fd_used** near **fd_total** is a descriptor leak. These figures refresh every few seconds.

```sh
curl -s -o /dev/null -w '%{http_code}\n' --netrc-file ~/.rabbitmq.netrc 'http://HOST:15672/api/health/checks/alarms'
```

200 means no alarm in the cluster; 503 means at least one, and the body names the node and resource (`disk space` or `memory`). Good for a load balancer or Kubernetes probe. Use HTTPS on port 15671 when TLS is on.

```sh danger
rabbitmqctl purge_queue QUEUE
```

Deletes every ready message in the queue; unacknowledged ones stay with their consumers. It cannot be undone. Use it for a poison backlog you have already saved or decided to drop. A missing queue prints "Object (queue, stream, exchange, etc) was not found".

```sh danger
rabbitmqctl stop_app && rabbitmqctl start_app
```

Restarts the RabbitMQ app inside the same Erlang VM, closing every client connection on that node. Non-persistent messages in classic queues are lost. Use it to clear a stuck broker without rebooting. In a cluster check `check_if_node_is_quorum_critical` first.

### RabbitMQ: alarms that block publishers

```sh changes
rabbitmqctl set_vm_memory_high_watermark 0.5
```

Sets the memory alarm threshold to half of RAM for this run only; a restart restores the config value. When used memory passes it, the broker blocks every publishing connection until it falls back. Raising it buys time but leaves less headroom for the OS: fix what holds memory (**memory_breakdown**, long queues) instead.

```sh
rabbitmqctl list_connections name state
```

During a memory or disk alarm, publishers show `blocked` and idle connections `blocking`, as seen with a 50 MB threshold. Consumers keep working, so draining the queues is what clears the alarm. Clients should handle the `connection.blocked` notification.

```sh changes
rabbitmqctl set_disk_free_limit 2GB
```

Changes the free-disk threshold for the running node (default 50MB, a restart restores the config value). Below it the broker raises a "Free disk space alarm" and blocks publishers. Set it to at least the size of RAM if the node can page messages to disk; free space or grow the volume.

### RabbitMQ errors

```text
Error when reading /var/lib/rabbitmq/.erlang.cookie: eacces
```

The Erlang VM cannot read its cookie file, so the node will not start. The file must be owned by the user that runs RabbitMQ with mode 400 or 600. **Fix** with `chown` and `chmod`. The same cookie must exist for CLI tools and cluster peers.

```text
Error: unable to perform an operation on node 'rabbit@rmq1'. Please see diagnostics information and suggestions below.
```

The CLI could not reach the node. Causes, in order: the node is down, the name or hostname differs from `-n`, or the CLI's cookie does not match the node's. The diagnostics below the error say which; start with `rabbitmq-diagnostics ping`.

```text
ProbableAuthenticationError ConnectionClosedByBroker: (403) 'ACCESS_REFUSED - Login was refused using authentication mechanism PLAIN. For details see the broker logfile.'
```

Wrong user or password, or an auth backend refusal. The broker log has the reason: `PLAIN login refused: user 'probe' - invalid credentials`. The `guest` user can connect only from localhost. Test with `rabbitmqctl authenticate_user` and the user name only: it prompts for the password, which then stays out of the process list.

```text
NOT_ALLOWED - vhost nope not found
```

The client named a virtual host that does not exist (it arrives as a 530 connection close). **Check** `rabbitmqctl list_vhosts` and the client's vhost setting. A vhost the user has no permission on gives `access to vhost ... refused` instead.

```text
PRECONDITION_FAILED - inequivalent arg 'durable' for queue 'q1' in vhost '/': received 'false' but current is 'true'
```

The client redeclared a queue with different settings. RabbitMQ never changes a queue's arguments in place. Match the declaration, or delete the queue and declare it again once you have drained it. Policies change `x-` settings without a redeclare.

```text
NOT_FOUND - no queue 'missing-q' in vhost '/'
```

A consume or a passive declare named a queue that does not exist. A typo, a wrong vhost, or a queue deleted by an expiry or auto-delete rule. **Check** `rabbitmqctl list_queues -p` with the vhost the client uses.

```text
PRECONDITION_FAILED - delivery acknowledgement on channel 1 timed out. Timeout value used: 1800000 ms. This timeout value can be configured, see consumers doc guide
```

A consumer held a delivery for longer than `consumer_timeout` (30 minutes by default) without acking, so the broker closed the channel. Ack sooner, move slow work off the delivery path, or raise `consumer_timeout`. The message returns to the queue.

```text
missed heartbeats from client, timeout: 60s
```

Log reason for a closed connection: the client sent no frame for two heartbeat intervals. The client is blocked (a long GC, a busy single thread) or a firewall or load balancer dropped the idle connection. Shorten the heartbeat below the network device's idle timeout.

```text
{:unsupported, :rabbit_classic_queue}
```

You ran a quorum-only command, such as `rabbitmq-queues quorum_status`, against a classic queue. Check the queue's **type** in `list_queues name type`.

```text
Error:
No such queue was found
```

From `rabbitmqctl delete_queue` when the name is wrong or the vhost is not the default one. Add `-p` and the vhost name for another vhost.

## PostgreSQL

Most incidents are a lock, a long transaction, connection exhaustion, a full disk or a replica that fell behind. `pg_stat_activity` shows the first three; the replication and WAL groups show the rest.

### Connect

```sh
pg_isready -h HOST -p 5432
```

Exit 0: accepting. 1: rejecting, usually still starting up. 2: no response.

```sh
psql "host=HOST dbname=DB user=DBUSER sslmode=require"
```

Then `\conninfo`, `\l`, `\dt+`, `\d+ TABLENAME`, `\x auto`, `\timing on`. Keep the password in `~/.pgpass` (mode 0600), not on the command line.

```sql
SELECT version(), pg_postmaster_start_time(), pg_is_in_recovery();
SHOW data_directory;
```

Which server you are on, since when, and whether it is a standby (`t`). A start time of a few minutes ago means a restart or a crash loop: read the server log next.

```sql changes
SHOW hba_file;
SELECT pg_reload_conf();
```

Where the auth rules live. A reload applies `pg_hba.conf` and most settings; `listen_addresses`, `max_connections` and `shared_buffers` need a restart.

```sh
journalctl -u 'postgresql*' -n 100
```

The server log, when it goes to the journal. With `logging_collector` on (the RHEL and PGDG RPM default) the journal holds only start and stop, and `psql -c 'SELECT pg_current_logfile()'` names the real file, under `DATADIR/log/`. On Debian and Ubuntu it is under `/var/log/postgresql/` instead. In the official Docker image it goes to `docker logs CTR`.

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
SELECT wait_event_type, wait_event, count(*)
FROM pg_stat_activity WHERE state = 'active'
GROUP BY 1, 2 ORDER BY 3 DESC;
```

Where active sessions spend their time. `Lock` means they queue behind a lock, `IO` means reads or writes, `LWLock` means internal contention, `Client` means the app is slow to read results. An empty type is plain CPU.

```sql
SELECT pid, usename, application_name, client_addr, state,
       now() - query_start AS running_for, left(query, 80) AS query
FROM pg_stat_activity
WHERE state = 'active' AND backend_type = 'client backend'
  AND now() - query_start > interval '30 seconds'
ORDER BY running_for DESC;
```

Queries running longer than 30 seconds, with the app and client to blame. Check `wait_event_type` before cancelling: a query waiting on a `Lock` needs the blocker found, not killed.

```sql
SELECT pid, pg_blocking_pids(pid) AS blocked_by,
       wait_event_type, left(query, 60) AS query
FROM pg_stat_activity
WHERE cardinality(pg_blocking_pids(pid)) > 0;
```

Who waits on whom. Follow `blocked_by` to the root blocker, usually a long or idle-in-transaction session.

```sql changes
SELECT pg_cancel_backend(PID);
```

Cancels the running query. The session stays. Try this before the next entry.

```sql changes
SELECT pg_terminate_backend(PID);
```

Ends the session and rolls back its transaction. The client sees "terminating connection due to administrator command" and must reconnect.

```sql
SET lock_timeout = '5s';
```

Run it before `ALTER TABLE` in a migration. DDL waiting for a lock queues every later query behind it; this makes it give up instead.

### Connections and pooling

```sql
SELECT backend_type, state, count(*) FROM pg_stat_activity GROUP BY 1, 2 ORDER BY 3 DESC;
SHOW max_connections;
```

Connections by type and state, against the limit. Only `client backend` rows count against `max_connections`; walsenders and background workers have their own slots.

```sql
SELECT count(*) AS total,
       count(*) FILTER (WHERE state = 'active') AS active,
       count(*) FILTER (WHERE state LIKE 'idle in transaction%') AS idle_tx,
       current_setting('max_connections')::int AS max,
       current_setting('superuser_reserved_connections')::int AS reserved
FROM pg_stat_activity WHERE backend_type = 'client backend';
```

Headroom at a glance. Total near `max` minus `reserved` and most of it `idle`: the app pools are oversized. Many `idle_tx`: sessions that begin and never commit.

```sql
SELECT usename, datname, application_name, client_addr, count(*)
FROM pg_stat_activity WHERE backend_type = 'client backend'
GROUP BY 1, 2, 3, 4 ORDER BY 5 DESC;
```

Which app host or role uses the slots. One client address with hundreds of connections is a pool without a cap or a connection leak.

```sql
SELECT rolname, rolconnlimit FROM pg_roles WHERE rolconnlimit <> -1;
SELECT datname, datconnlimit FROM pg_database WHERE datconnlimit <> -1;
```

Per-role and per-database caps. They produce "too many connections for role" and "too many connections for database" long before `max_connections` is reached.

```sh
psql -h HOST -p 6432 -U DBUSER pgbouncer -c 'SHOW POOLS;'
```

PgBouncer's admin console (the database named `pgbouncer`, the user must be in `admin_users` or `stats_users`). **cl_waiting** above 0 means clients queue for a server connection; **maxwait** is the longest wait in seconds. **sv_active** at the pool size with waiting clients: raise `default_pool_size`, or find the slow queries holding the servers. Columns shown are from PgBouncer 1.26.

```sh
psql -h HOST -p 6432 -U DBUSER pgbouncer -c 'SHOW CLIENTS;' -c 'SHOW SERVERS;'
```

One row per client and per server connection. A client with `state` waiting has `link` empty and a growing **wait**; an active one points by **link** to the server connection it uses, whose **remote_pid** is the `pid` in `pg_stat_activity`. Use it to find which app host holds the pool.

```sh
psql -h HOST -p 6432 -U DBUSER pgbouncer -c 'SHOW STATS;' -c 'SHOW DATABASES;' -c 'SHOW LISTS;' -c 'SHOW CONFIG;'
```

**total_wait_time** and **avg_wait_time** (microseconds) show queueing per database. `SHOW DATABASES` gives the real target, pool size and `paused` or `disabled` flags. `SHOW LISTS` counts clients and servers in use. `SHOW CONFIG` prints the live setting, so you can tell a stale reload.

```sh changes
psql -h HOST -p 6432 -U DBUSER pgbouncer -c 'PAUSE DB;'
```

Waits for in-flight transactions to finish, then holds new ones, so you can restart the backend. In session pooling it waits for every client to disconnect. Every app on that database waits until `RESUME DB;`.

```sh changes
psql -h HOST -p 6432 -U DBUSER pgbouncer -c 'RESUME DB;'
```

Lets the held clients through after a `PAUSE`. Paused with clients still piling up: run this first.

```sh changes
psql -h HOST -p 6432 -U DBUSER pgbouncer -c 'RELOAD;'
```

Re-reads `pgbouncer.ini` and the auth file; open connections stay.

```sh danger
psql -h HOST -p 6432 -U DBUSER pgbouncer -c 'KILL DB;'
```

Drops every client and server connection of that database at once. Applications see broken connections and must reconnect. Prefer `PAUSE` and `RESUME`.

### Locks and deadlocks

```sql
SELECT a.pid, a.usename, a.state, a.wait_event_type, a.wait_event,
       l.locktype, l.mode, l.granted, l.relation::regclass AS rel,
       left(a.query, 60) AS query
FROM pg_locks l JOIN pg_stat_activity a USING (pid)
WHERE NOT l.granted OR l.locktype = 'transactionid'
ORDER BY a.pid;
```

Held and waited locks side by side. A row with `granted` false is a waiter. A row-lock wait shows as a `transactionid` lock in `ShareLock` mode, not a lock on the row: the waiter sits behind the transaction that owns that id. A waiting `relation` lock is DDL, an explicit LOCK, or an ordinary query queued behind one.

```sql
SELECT l.pid, l.mode, l.relation::regclass AS rel, a.state,
       now() - a.xact_start AS xact_age, left(a.query, 60) AS query
FROM pg_locks l JOIN pg_stat_activity a USING (pid)
WHERE l.locktype = 'relation' AND l.relation = 'TABLENAME'::regclass
ORDER BY l.granted DESC, a.xact_start;
```

Every session holding or waiting for a lock on one table, holders first. `AccessExclusiveLock` from `ALTER TABLE`, `VACUUM FULL` or `LOCK` blocks every reader behind it; a waiting `AccessExclusiveLock` also blocks all later queries.

```sql
SELECT locktype, classid, objid, mode, granted, pid
FROM pg_locks WHERE locktype = 'advisory';
```

Application-level advisory locks. Look for a pid that holds one while the queue of waiters grows; the app, not the schema, is the cause.

```sql
SHOW log_lock_waits;
SHOW deadlock_timeout;
```

With `log_lock_waits` on, any wait longer than `deadlock_timeout` (default 1s) is logged, and the deadlock check runs at the same moment. Set it to on in production: it is the only record of a lock wait after it ends.

```text
LOG:  process 332 still waiting for ShareLock on transaction 756 after 1000.083 ms
DETAIL:  Process holding the lock: 325. Wait queue: 332.
CONTEXT:  while updating tuple (0,1) in relation "t"
```

A row-lock wait. The holder is process 325; find it with `pg_stat_activity`. When the wait ends, a second line says "acquired ShareLock on transaction 756 after 4999.284 ms". The `STATEMENT` line shows the waiter's query.

```text
ERROR:  deadlock detected
DETAIL:  Process 360 waits for ShareLock on transaction 759; blocked by process 367.
	Process 367 waits for ShareLock on transaction 758; blocked by process 360.
	Process 360: update t set v='d1' where id=11
	Process 367: update t set v='d2' where id=10
HINT:  See server log for query details.
```

The server log names both queries and processes. PostgreSQL aborted one transaction (here 360) to break the cycle. Fix the application to touch rows in one fixed order, and retry the aborted transaction. `pg_stat_database.deadlocks` counts them.

```sql
SELECT datname, deadlocks, conflicts, temp_files,
       pg_size_pretty(temp_bytes) AS temp_bytes
FROM pg_stat_database WHERE datname = 'DB';
```

Deadlocks and temp-file spills since the last stats reset. `deadlocks` rising points at the lock-order bug above; many `temp_files` mean sorts and hashes spill because `work_mem` is too small.

```sql
SET lock_timeout = '2s';
SET statement_timeout = '30s';
```

Per-session limits for a migration or a script. `lock_timeout` ends the wait with "canceling statement due to lock timeout"; `statement_timeout` ends a running query with "canceling statement due to statement timeout". Put them in the role with `ALTER ROLE ... SET` for apps.

### Long transactions and the xmin horizon

```sql
SELECT pid, usename, application_name, state,
       now() - xact_start AS xact_age,
       greatest(age(backend_xid), age(backend_xmin)) AS xmin_age,
       left(query, 60) AS query
FROM pg_stat_activity
WHERE backend_xid IS NOT NULL OR backend_xmin IS NOT NULL
ORDER BY greatest(age(backend_xid), age(backend_xmin)) DESC NULLS LAST;
```

Sessions pinning old row versions. Vacuum cannot remove a row that any of them might still see. The top row is your horizon holder; "idle in transaction" in `state` is the usual culprit. `xmin_age` counts transactions, not time.

```sql
SELECT 'slot' AS holder, slot_name::text AS name, xmin, catalog_xmin, greatest(age(xmin), age(catalog_xmin)) AS xmin_age
FROM pg_replication_slots WHERE xmin IS NOT NULL OR catalog_xmin IS NOT NULL
UNION ALL
SELECT 'prepared xact', gid, transaction, NULL, age(transaction) FROM pg_prepared_xacts
UNION ALL
SELECT 'standby feedback', application_name, backend_xmin, NULL, age(backend_xmin)
FROM pg_stat_replication WHERE backend_xmin IS NOT NULL;
```

The other things that hold the horizon besides sessions: replication slots (a logical slot holds `catalog_xmin`), forgotten prepared transactions, and standbys with `hot_standby_feedback` on. With a slot, the standby's feedback shows in the slot's `xmin`, not in `pg_stat_replication`.

```sql
SELECT gid, prepared, owner, database, age(transaction) AS xid_age
FROM pg_prepared_xacts;
```

Two-phase transactions left by a crashed coordinator. They survive restarts, keep locks and hold back vacuum. Needs `max_prepared_transactions` above 0 (default 0). Check **prepared** for old rows.

```sql danger
ROLLBACK PREPARED 'GID';
```

Rolls back a prepared transaction by its `gid`; use `COMMIT PREPARED 'GID'` instead if the coordinator had decided to commit. Connect to the database in the `database` column first, or it fails with "prepared transaction belongs to another database". Ask the owning app first: a wrong choice loses or duplicates work.

```text pg15+
removable cutoff: 772, which was 1 XIDs old when operation ended
tuples: 0 removed, 86642 remain, 0 are dead but not yet removable
```

From `VACUUM (VERBOSE)` or an autovacuum log line. The **removable cutoff** is the xmin horizon vacuum used. If it is far behind the current transaction id, something above holds it. Dead rows "not yet removable" are the ones kept alive by it. PostgreSQL 14 has no cutoff line: the horizon is the `oldest xmin` at the end of the tuples line.

```sql
SET idle_in_transaction_session_timeout = '60s';
```

Ends sessions that sit "idle in transaction" longer than that, with "terminating connection due to idle-in-transaction timeout". Set it per role for apps. Never set it for a role that runs long manual work.

### Vacuum and bloat

```sql
SELECT relname, n_live_tup, n_dead_tup,
       round(100.0 * n_dead_tup / nullif(n_live_tup + n_dead_tup, 0), 1) AS dead_pct,
       last_autovacuum, last_autoanalyze, autovacuum_count
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC LIMIT 10;
```

Tables with the most dead rows. A high `dead_pct` with an old or empty `last_autovacuum`: autovacuum is not reaching the table. Check the horizon, `autovacuum_enabled` in the table options, and the workers.

```sql
SELECT pid, datname, relid::regclass AS tbl, phase,
       round(100.0 * heap_blks_scanned / nullif(heap_blks_total, 0), 1) AS pct_scanned,
       index_vacuum_count
FROM pg_stat_progress_vacuum;
```

A running vacuum or autovacuum. `index_vacuum_count` above 1 means the dead-row list overflowed `maintenance_work_mem` and vacuum rescans the indexes; raise it. A wait event of `VacuumDelay` in `pg_stat_activity` is the cost throttle.

```sql
SELECT name, setting, unit FROM pg_settings
WHERE name LIKE 'autovacuum%' OR name LIKE 'vacuum_%'
ORDER BY name;
```

The thresholds that decide when autovacuum fires: `autovacuum_vacuum_scale_factor` 0.2 means after 20 percent of the table changed, which is far too late on a huge table. Cost settings decide how fast it runs; the default throttle is gentle.

```sql
SELECT relname, reloptions FROM pg_class
WHERE reloptions IS NOT NULL AND relkind = 'r';
```

Per-table autovacuum overrides, including `autovacuum_enabled=false` left over from a bulk load. Tune a hot table with `ALTER TABLE ... SET (autovacuum_vacuum_scale_factor = 0.01)`.

```sql changes
VACUUM (VERBOSE, ANALYZE) TABLENAME;
```

Vacuums and analyzes one table in your session without blocking reads or writes, except that the final truncation briefly takes ACCESS EXCLUSIVE; `VACUUM (TRUNCATE false, VERBOSE, ANALYZE)` avoids it. The verbose output shows pages removed, dead rows "not yet removable", and the cutoff. It returns space to the OS only from the end of the file.

```text
LOG:  automatic vacuum of table "app.public.av1": index scans: 0
	pages: 34 removed, 222 remain, 256 scanned (100.00% of total)
	tuples: 16666 removed, 33334 remain, 0 are dead but not yet removable
```

Autovacuum finished one table; this needs `log_autovacuum_min_duration` set (0 logs all). Removed tuples show the work; many "dead but not yet removable" show a horizon holder. Long **elapsed** and many index scans: raise `maintenance_work_mem`. PostgreSQL 14 prints `0 skipped due to pins, 0 skipped frozen` in place of the scanned count, and adds `oldest xmin` to the tuples line.

```text
ERROR:  canceling autovacuum task
```

A lock request (DDL, `LOCK TABLE`) conflicted with autovacuum, which backs off. If it repeats on the same table, autovacuum never finishes there. Schedule the DDL differently, and vacuum by hand in a quiet period.

```sql changes
CREATE EXTENSION IF NOT EXISTS pgstattuple;
SELECT table_len, dead_tuple_percent, approx_free_percent
FROM pgstattuple_approx('TABLENAME');
```

A bloat estimate that skips the all-visible pages and reads the rest (`pgstattuple()` is exact but reads it all). **dead_tuple_percent** is rows vacuum can reclaim; **approx_free_percent** is space inside the file that stays allocated and is reusable. Contrib module; the extension needs superuser to create.

```sql
SELECT index_size, avg_leaf_density, leaf_fragmentation
FROM pgstatindex('INDEXNAME');
```

A btree's health. It reads the whole index, so it is slow on a large one. **avg_leaf_density** far below 90 (the fill factor default) with a large `index_size` is a bloated index; **leaf_fragmentation** above about 30 hurts range scans. Fix with `REINDEX INDEX CONCURRENTLY INDEXNAME;`, which needs the extra disk space of a second copy.

```sql danger
VACUUM FULL TABLENAME;
```

Rewrites the table and returns space to the OS, but takes an `ACCESS EXCLUSIVE` lock for the whole run, so reads and writes queue, and it needs free disk equal to the table. Prefer a normal vacuum, or `pg_repack` (an extension, not in core) for online work.

### Transaction ID wraparound

```sql
SELECT datname, age(datfrozenxid) AS xid_age, mxid_age(datminmxid) AS mxid_age,
       round(100.0 * age(datfrozenxid) / current_setting('autovacuum_freeze_max_age')::int) AS pct_of_freeze_max
FROM pg_database ORDER BY 2 DESC;
```

How close each database is to a forced vacuum. At 100 percent of `autovacuum_freeze_max_age` (default 200 million) autovacuum starts an aggressive anti-wraparound pass, even if autovacuum is off. A limit near 2 billion stops writes; `mxid_age` follows the same logic for multixacts.

```sql
SELECT c.oid::regclass AS tbl, age(c.relfrozenxid) AS xid_age,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS size
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'm', 't')
ORDER BY age(c.relfrozenxid) DESC LIMIT 10;
```

The tables that hold `datfrozenxid` back. Run `VACUUM (FREEZE, VERBOSE)` on the top ones, after the horizon holders in the group above are gone, or the freeze cannot advance.

```text
WARNING:  database "template1" must be vacuumed within 3484377 transactions
HINT:  To avoid transaction ID assignment failures, execute a database-wide VACUUM in that database.
You might also need to commit or roll back old prepared transactions, or drop stale replication slots.
```

Fewer than about 40 million transactions remain before PostgreSQL refuses new transaction ids, and writes stop when the number reaches 3 million, not 0. Act now: remove horizon holders (prepared transactions, slots, old sessions), then run `VACUUM` in the named database. PostgreSQL 14 to 16 word the hint "To avoid a database shutdown".

```text
WARNING:  bypassing nonessential maintenance of table "postgres.pg_catalog.pg_type" as a failsafe after 0 index scans
DETAIL:  The table's relfrozenxid or relminmxid is too far in the past.
```

Vacuum hit `vacuum_failsafe_age` (default 1.6 billion) and now skips index cleanup and throttling to finish freezing fast. It is a rescue, not an error. Find why vacuum fell so far behind.

```text
ERROR:  database is not accepting commands that assign new transaction IDs to avoid wraparound data loss in database "DB"
```

Writes are refused a few million ids before wraparound. Fix: stop writers, remove prepared transactions and stale slots, then run `VACUUM` in that database; if even that is refused, start in single-user mode (next entry). Reads still work. Wording differs slightly before PostgreSQL 17.

```sh danger
postgres --single -D DATADIR DB
```

Single-user mode for the wraparound fix above: stop the server first and run it as the `postgres` user. Type `VACUUM;` at the prompt, then press Ctrl-D. It turns off the wraparound safeguards, so use it only when `VACUUM` itself is refused.

### Slow queries

```sql
SELECT calls, round(total_exec_time) AS total_ms,
       round(mean_exec_time::numeric, 1) AS mean_ms, rows, left(query, 80) AS query
FROM pg_stat_statements
ORDER BY total_exec_time DESC LIMIT 10;
```

The queries that cost the most time in total. Needs `pg_stat_statements` in `shared_preload_libraries` (restart), then `CREATE EXTENSION` in the database you query it from. Without the preload: "pg_stat_statements must be loaded via shared_preload_libraries". Values are cluster-wide.

```sql
SELECT calls, round(mean_exec_time::numeric, 1) AS mean_ms,
       round(stddev_exec_time::numeric, 1) AS stddev_ms, rows, left(query, 80) AS query
FROM pg_stat_statements WHERE calls > 20
ORDER BY mean_exec_time DESC LIMIT 10;
```

Slow per call rather than slow in total. A large `stddev_ms` against `mean_ms` means the plan or the lock waits vary, so look for parameter-dependent plans or contention.

```sql
SELECT round(100.0 * shared_blks_hit / nullif(shared_blks_hit + shared_blks_read, 0), 1) AS hit_pct,
       shared_blks_read, temp_blks_written, left(query, 70) AS query
FROM pg_stat_statements
ORDER BY shared_blks_read + temp_blks_written DESC LIMIT 10;
```

The queries doing the I/O. Low `hit_pct` means reads from disk (cold data or missing index); `temp_blks_written` above 0 means sorts or hashes spilled for lack of `work_mem`. Time columns need `track_io_timing` on.

```sql pg17+
SELECT shared_blk_read_time, shared_blk_write_time, local_blk_read_time, stats_since
FROM pg_stat_statements LIMIT 3;
```

Buffer I/O time per statement, PostgreSQL 17 names; `stats_since` is when each entry started. In 14 to 16 the columns are `blk_read_time` and `blk_write_time`. In 17 and later `stats_since` tells you how long to trust the counters.

```sql changes
SELECT pg_stat_statements_reset();
```

Clears all statement counters, so the next look shows only fresh load. Do it before reproducing a problem, not before capturing the evidence you have.

```sql
SELECT pid, query_id, now() - query_start AS running_for, left(query, 60) AS query
FROM pg_stat_activity WHERE state = 'active' AND query_id IS NOT NULL;
```

`query_id` (PostgreSQL 14+, needs `compute_query_id` auto or on) joins a live session to `pg_stat_statements.queryid`, so you can see the history of what is running now.

```sql
EXPLAIN (ANALYZE, BUFFERS) SELECT ...;
```

Runs the query for real. Look for estimated rows far from actual (run `ANALYZE` on the table), a Seq Scan on a big table with a selective filter (missing index), and "external merge Disk" (`work_mem` too small). `Buffers: shared read` is disk, `hit` is cache.

```sql changes
BEGIN; SET LOCAL lock_timeout = '2s'; EXPLAIN ANALYZE UPDATE ...; ROLLBACK;
```

Analyzes a write and undoes it, but it runs for real: until ROLLBACK it holds its row locks, fires triggers and writes WAL, and sequence values and writes through foreign tables or dblink stay. The lock timeout keeps it from queueing behind others; on a busy table, run it on a copy (a replica cannot run an UPDATE).

```sql
LOAD 'auto_explain';
SET auto_explain.log_min_duration = '500ms';
SET auto_explain.log_analyze = on;
SET auto_explain.log_buffers = on;
```

Logs the plan of any statement over 500 ms in this session, with actual rows and buffers, so you catch the plan of a slow query as the app really runs it (superuser needed for `LOAD`). For all sessions put `auto_explain` in `shared_preload_libraries`. `log_analyze` adds timing overhead. The logged query text includes literal values.

```text
LOG:  duration: 6.210 ms  plan:
	Query Text: select count(*) from t where v like 'a%';
	Aggregate  (cost=2099.15..2099.16 rows=1 width=8) (actual time=6.205..6.206 rows=1 loops=1)
	  ->  Seq Scan on t  (cost=0.00..2084.00 rows=6061 width=0) (actual time=0.007..6.029 rows=6176 loops=1)
```

An `auto_explain` entry in the server log. Compare **rows** (estimate) with **actual rows** at each node, and look at **Rows Removed by Filter**: a large count with a Seq Scan wants an index.

```sql
SELECT relname, seq_scan, seq_tup_read, idx_scan, n_live_tup
FROM pg_stat_user_tables
ORDER BY seq_tup_read DESC LIMIT 10;
```

Big tables read by sequential scans are index candidates. `seq_tup_read` is the total rows read that way, so it ranks the cost better than the scan count.

```sh changes
psql -h HOST -d DB -c "ALTER SYSTEM SET log_min_duration_statement = '1s'" -c "SELECT pg_reload_conf()"
```

Logs every statement slower than one second, with its duration, from now on (changes `postgresql.auto.conf`; undo with `ALTER SYSTEM RESET log_min_duration_statement`). Cheaper than `auto_explain` when you only need the text. Logged statements include literal values, so the log may hold secrets.

### Indexes

```sql
SELECT i.indexrelid::regclass AS idx, i.indrelid::regclass AS tbl, i.indisvalid, i.indisready
FROM pg_index i WHERE NOT i.indisvalid;
```

Invalid indexes. A failed or cancelled `CREATE INDEX CONCURRENTLY` leaves one behind: it is maintained on every write but never used. Drop it with `DROP INDEX CONCURRENTLY` and retry, after fixing the cause (often duplicate data for a unique index). A concurrent build still in progress also shows here: check `pg_stat_progress_create_index` before dropping.

```text
ERROR:  could not create unique index "ix_k_uniq"
DETAIL:  Key (k)=(dup) is duplicated.
```

A unique index cannot build because the data already has duplicates. With `CONCURRENTLY` the failed index stays, invalid. Find the duplicates with `GROUP BY k HAVING count(*) > 1`, resolve them, drop the invalid index, and build again.

```sql
SELECT pid, relid::regclass AS tbl, index_relid::regclass AS idx, phase,
       blocks_done, blocks_total, tuples_done
FROM pg_stat_progress_create_index;
```

A running `CREATE INDEX` or `REINDEX`. A phase of "waiting for old snapshots" or "waiting for writers" with `CONCURRENTLY` means it waits for old transactions to finish: look for a long one in the horizon group.

```sql
SELECT s.schemaname, s.relname, s.indexrelname, s.idx_scan,
       pg_size_pretty(pg_relation_size(s.indexrelid)) AS size
FROM pg_stat_user_indexes s JOIN pg_index i USING (indexrelid)
WHERE s.idx_scan = 0 AND NOT i.indisunique AND NOT i.indisprimary
ORDER BY pg_relation_size(s.indexrelid) DESC LIMIT 10;
```

Indexes never used since the last stats reset. They slow every write and waste disk. Check how long the stats have run (`stats_reset` in `pg_stat_database`) and check standbys too, since they keep their own counts. Unique and primary indexes are left out on purpose.

```sql changes
REINDEX INDEX CONCURRENTLY INDEXNAME;
```

Rebuilds one index without blocking writes, needs disk for a second copy, and takes about as long as the first build. If it fails it leaves an invalid index with a `_ccnew` suffix; drop that.

### Space

```sql
SELECT relname, pg_size_pretty(pg_total_relation_size(relid)) AS size,
       n_dead_tup, last_autovacuum
FROM pg_stat_user_tables
ORDER BY pg_total_relation_size(relid) DESC LIMIT 10;
```

Biggest tables and their dead rows. Many dead rows and an old `last_autovacuum`: vacuum cannot keep up, or an old transaction blocks it.

```sql
SELECT datname, pg_size_pretty(pg_database_size(datname)) FROM pg_database ORDER BY pg_database_size(datname) DESC;
```

Database sizes. Then look inside the biggest with the table query above. Remember `pg_wal` and temp files live outside these numbers.

### WAL and checkpoints

```sql
SELECT count(*) AS files, pg_size_pretty(sum(size)) AS wal_size FROM pg_ls_waldir();
SELECT pg_walfile_name(pg_current_wal_lsn()), pg_current_wal_lsn();
```

How much WAL is on disk, and where writing is now. WAL far above `max_wal_size` means something retains it: a lagging or inactive slot, a failing `archive_command`, or `wal_keep_size`. `pg_current_wal_lsn()` does not run on a standby.

```sql
SELECT archived_count, failed_count, last_archived_wal, last_archived_time,
       last_failed_wal, last_failed_time
FROM pg_stat_archiver;
```

WAL archiving. A `last_failed_time` newer than `last_archived_time` means the archive command fails, and `pg_wal` grows until the disk fills. The server log says "archive command failed with exit code 1" with the command.

```sql pg17+
SELECT num_timed, num_requested, write_time, sync_time, buffers_written
FROM pg_stat_checkpointer;
```

PostgreSQL 17 and later: checkpoint counters moved here from `pg_stat_bgwriter`. **num_requested** much larger than **num_timed** means checkpoints are forced by WAL volume: raise `max_wal_size`. 18 adds `num_done` and `slru_written`.

```sql
SELECT checkpoints_timed, checkpoints_req, checkpoint_write_time,
       checkpoint_sync_time, buffers_checkpoint, buffers_backend
FROM pg_stat_bgwriter;
```

PostgreSQL 14 to 16 only; from 17 these columns are gone (use `pg_stat_checkpointer`). **checkpoints_req** well above **checkpoints_timed**: raise `max_wal_size`. High `buffers_backend` means backends write dirty pages themselves.

```text
LOG:  checkpoints are occurring too frequently (0 seconds apart)
HINT:  Consider increasing the configuration parameter "max_wal_size".
```

WAL fills `max_wal_size` before `checkpoint_timeout` (default 5 minutes) and forces a checkpoint, with I/O spikes each time. Raise `max_wal_size` (a reload suffices). Enable `log_checkpoints` to see each one with its reason: "wal" or "time".

```sql
SELECT wal_records, wal_fpi, pg_size_pretty(wal_bytes) AS wal, wal_buffers_full
FROM pg_stat_wal;
```

WAL volume since reset. High `wal_fpi` (full-page images) right after each checkpoint is normal; if it dominates, checkpoints are too frequent. `wal_buffers_full` rising: raise `wal_buffers`. In PostgreSQL 18 the write and sync counters moved to `pg_stat_io`.

```sql pg16+
SELECT backend_type, object, context, reads, writes, fsyncs
FROM pg_stat_io WHERE reads > 0 OR writes > 0 ORDER BY writes DESC NULLS LAST LIMIT 10;
```

PostgreSQL 16 and later. I/O by process type, so you can see whether the checkpointer, backends or autovacuum do the writing. Read and write times appear when `track_io_timing` is on.

### Replication

```sql
SELECT application_name, client_addr, state, sync_state,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), sent_lsn)) AS send_lag,
       pg_size_pretty(pg_wal_lsn_diff(sent_lsn, replay_lsn)) AS replay_lag_bytes,
       write_lag, flush_lag, replay_lag
FROM pg_stat_replication;
```

On the primary: each standby and logical subscriber with its lag, in bytes and time. `state` should be `streaming` (`catchup` after a restart, `startup` first). A large `send_lag` is the primary or network; a large `replay_lag_bytes` with a small send lag means the standby is slow to apply, often blocked by a query. The lag times are empty on an idle primary.

```sql
SELECT now() - pg_last_xact_replay_timestamp() AS replay_age,
       pg_last_wal_receive_lsn() AS received, pg_last_wal_replay_lsn() AS replayed,
       pg_is_wal_replay_paused() AS paused;
```

On a standby: the age of the last replayed change. It also grows when the primary is idle. Received ahead of replayed means apply is behind, which is normal under a conflicting query or when replay is paused.

```sql
SELECT status, receive_start_lsn, written_lsn, flushed_lsn, latest_end_lsn,
       slot_name, sender_host, last_msg_receipt_time
FROM pg_stat_wal_receiver;
```

On a standby: the WAL receiver. No row, or `status` not `streaming`, means it is not connected to the primary: check `primary_conninfo`, the network and the log. A stale `last_msg_receipt_time` with `streaming` status means the primary or link stopped sending.

```sql
SELECT slot_name, slot_type, active, wal_status,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained
FROM pg_replication_slots;
```

An inactive slot keeps WAL forever and fills the disk. **wal_status**: `reserved` is fine, `extended` is beyond `max_wal_size` but kept, `unreserved` will be removed at the next checkpoint unless the consumer catches up first, `lost` is gone for good. If its consumer is gone: `SELECT pg_drop_replication_slot('SLOTNAME');`

```sql pg17+
SELECT slot_name, active, wal_status, safe_wal_size, invalidation_reason, inactive_since
FROM pg_replication_slots;
```

PostgreSQL 17 and later. **invalidation_reason** `wal_removed` means the slot exceeded `max_slot_wal_keep_size` and its consumer must be rebuilt; **inactive_since** says how long nobody has used it. `safe_wal_size` is how much WAL can still be written before losing it. PostgreSQL 18 adds the reason `idle_timeout`.

```sql danger
SELECT pg_drop_replication_slot('SLOTNAME');
```

Removes the slot and lets the primary delete the WAL it held. Safe only if its consumer is gone or already beyond recovery; a standby on a dropped slot may need a fresh base backup.

```sql pg15+
SELECT subname, pid, received_lsn, latest_end_time FROM pg_stat_subscription;
SELECT subname, apply_error_count, sync_error_count FROM pg_stat_subscription_stats;
```

On the subscriber (logical replication, PostgreSQL 15 and later for the second view). A null `pid` means the apply worker is down. Rising `apply_error_count` means it fails and retries every few seconds: read the subscriber's log for the error. PostgreSQL 18 adds `confl_*` counters per conflict type.

```sql
SELECT srsubid, srrelid::regclass AS tbl, srsubstate FROM pg_subscription_rel;
```

Per-table initial-sync state: `i` initialising, `d` copying, `f` copy finished, `s` synchronised, `r` ready. A table stuck before `r` has not finished its first copy, so its data is incomplete.

```text
ERROR:  duplicate key value violates unique constraint "t_pkey"
DETAIL:  Key (id)=(900001) already exists.
CONTEXT:  processing remote data for replication origin "pg_16396" during message type "INSERT" for replication target relation "public.t" in transaction 791, finished at 0/86D41B8
```

On a subscriber: a row from the publisher conflicts with data already there (someone wrote locally). The worker exits and retries, so replication stalls. Remove the conflicting local row, or skip the transaction as in the next entry. The slot on the publisher keeps WAL meanwhile.

```sql danger pg15+
ALTER SUBSCRIPTION SUBNAME SKIP (lsn = 'LSN');
```

PostgreSQL 15 and later. Skips the remote transaction whose **finished at** LSN appears in the error `CONTEXT`. It discards that whole transaction on this subscriber for good, so use it only after you know the data is expendable or fixed by hand. Log: "logical replication completed skipping transaction".

```text
FATAL:  could not receive data from WAL stream: ERROR:  requested WAL segment 00000001000000000000002F has already been removed
LOG:  waiting for WAL to become available at 0/2F23EDB0
```

On a standby that fell too far behind: the primary no longer has the WAL it needs (no slot, or the slot hit `max_slot_wal_keep_size`). It will retry forever. Rebuild it with a fresh `pg_basebackup`, or restore from archive if `restore_command` is set.

```text
ERROR:  can no longer get changes from replication slot "sub1"
DETAIL:  This slot has been invalidated because it exceeded the maximum reserved size.
```

On the publisher, for a logical slot lost to `max_slot_wal_keep_size`. PostgreSQL 18 says "can no longer access replication slot", with the reason `wal_removed`. The subscription cannot resume: recreate it (`DROP SUBSCRIPTION` then `CREATE SUBSCRIPTION`, with `copy_data` chosen on purpose) and raise the limit or fix the stalled consumer.

```sql changes
SELECT pg_wal_replay_pause();
```

On a standby: pauses replay while WAL keeps arriving. Use it to read a stable snapshot, or to stop a bad change from being applied. While paused, `pg_get_wal_replay_pause_state()` says `paused` and the lag grows. Always resume afterwards: a long pause fills `pg_wal` on the standby.

```sql changes
SELECT pg_wal_replay_resume();
```

Resumes replay on a paused standby, which then catches up on the WAL it received meanwhile.

```sql danger
SELECT pg_promote();
```

On a standby: makes it a primary. It cannot be undone, and the old primary must be fixed or rebuilt, never left running, or you get two primaries. Prefer Patroni's switchover if you use it. Check the old primary is down first.

### Failover with Patroni

```sh
patronictl -c FILE list
```

The cluster at a glance, one row per member (`-c FILE` is the Patroni config, often `/etc/patroni/patroni.yml`). **Role** `Leader` is the primary. **State** `streaming` is healthy; `running` is the leader, `stopped`, `start failed` or `crashed` need the log. **TL** must be equal on all members. The lag columns after **Receive LSN** and **Replay LSN** are in bytes (older versions show one "Lag in MB" column).

```sh
patronictl -c FILE history
```

One row per failover, with the old timeline **TL**, the **LSN** where it ended, the **Reason**, the **Timestamp** and the **New Leader**. Repeated rows in a short time mean flapping: check DCS reachability (`ttl`, `loop_wait`, `retry_timeout`) and the network between nodes.

```sh
patronictl -c FILE show-config
```

The dynamic configuration stored in the DCS (`ttl`, `loop_wait`, `retry_timeout`, `maximum_lag_on_failover`, `postgresql.parameters`). If the DCS is unreachable longer than `retry_timeout`, a primary demotes itself to protect data. Compare with the local `patroni.yml` for drift.

```sh
curl -s -o /dev/null -w '%{http_code}\n' http://HOST:8008/primary
```

The REST health check that load balancers use: 200 only when this node is the primary and holds the leader lock. `/replica` is 200 on a running replica, `/health` is 200 when PostgreSQL is up, and `/patroni` returns a JSON status document. Port 8008 is the documented example; yours is `restapi.listen`.

```sh changes
patronictl -c FILE switchover PGCLUSTER --candidate NODE
```

A planned, clean change of leader: connections drop for a few seconds. Only run it when all replicas are `streaming` with no lag. It asks for confirmation. Check the new leader with `list` afterwards and let the app reconnect.

```sh danger
patronictl -c FILE failover PGCLUSTER --candidate NODE
```

For a primary that is gone: promotes the candidate even though the old leader cannot cooperate, so unreplicated writes can be lost. Use `switchover` while the old leader is healthy.

```sh danger
patronictl -c FILE reinit PGCLUSTER NODE
```

Wipes the member's data directory and rebuilds it from the leader. Use it for a replica that diverged or fell off the WAL; never on the leader. The rebuild reads the whole database over the network.

```sh changes
patronictl -c FILE pause
```

Stops automatic failover (maintenance mode) so you can restart or work on nodes by hand. Do not leave a cluster paused: a primary failure then goes unnoticed.

```sh changes
patronictl -c FILE resume
```

Restores automatic failover after a pause.

```text
INFO: Lock owner: node1; I am node2
INFO: no action. I am (node2), ...
```

Normal Patroni heartbeat lines in its log, repeated every `loop_wait` seconds. They only say who holds the leader lock. Look at the first line that is not one of these (a WARNING or ERROR) to find the problem.

### Backup and restore

```sh
pg_basebackup -h HOST -U DBUSER -D DATADIR -X stream -c fast -P
```

A physical base backup into a new empty directory `DATADIR`, streaming the WAL it needs so the copy starts consistently. `-c fast` forces an immediate checkpoint instead of waiting up to `checkpoint_timeout`. Needs a role with `REPLICATION` and a `replication` line in `pg_hba.conf`; the password comes from `~/.pgpass`.

```sh
pg_verifybackup DATADIR
```

Checks a base backup against its `backup_manifest` (PostgreSQL 13 and later). "backup successfully verified" is the answer you want; a failed checksum or a missing file is reported by name. Verify backups on a schedule, not only at restore time.

```sh
pg_dump -h HOST -U DBUSER -Fc -f FILE DB
pg_restore -l FILE | head
```

A logical, compressed dump in custom format, then its table of contents. A custom-format dump can be restored selectively and in parallel. Run `pg_dump` with the same or a newer version than the server. It reads a consistent snapshot but holds an old xmin while it runs.

```sh changes
pg_restore -h HOST -U DBUSER -d DB -j 4 --no-owner --exit-on-error FILE
```

Restores into an existing, empty database in 4 parallel jobs (each job opens a connection; also builds indexes in parallel). `--exit-on-error` stops at the first failure instead of finishing with "errors ignored on restore: N". `--no-owner` skips the original owners, so the objects belong to `DBUSER`. Add `--clean --if-exists` to replace existing objects: this drops the existing tables and their data first. `-j` works on custom and directory formats, not plain SQL.

```text
pg_restore: error: could not execute query: ERROR:  role "ghost" does not exist
Command was: ALTER TABLE public.gt OWNER TO ghost;
```

The dump was taken with objects owned by a role this server does not have. Create the role first, or restore with `--no-owner` (and `--no-privileges` for grants). Without `--exit-on-error` the run goes on and ends with "warning: errors ignored on restore".

```text
pg_restore: error: input file does not appear to be a valid archive
```

The file is not a custom-format, directory or tar dump: compressed with gzip, truncated, or damaged in transfer. A plain SQL dump says "input file appears to be a text format dump. Please use psql." instead (run it with `psql -f FILE`). `pg_restore -l FILE` fails the same way.

```text
LOG:  starting point-in-time recovery to 2026-11-20 16:24:20.752568+00
LOG:  recovery stopping before commit of transaction 798, time 2026-11-20 16:24:24.543682+00
LOG:  pausing at the end of recovery
HINT:  Execute pg_wal_replay_resume() to promote.
```

A point-in-time recovery reaching its target with `recovery_target_action = 'pause'`. Check that the data is what you want (`SELECT`), then run `SELECT pg_wal_replay_resume();` to promote and end recovery. If it is the wrong point, restart from the base backup with an earlier target.

```sh changes
touch DATADIR/recovery.signal
```

Starts a restored base backup in archive recovery. Put `restore_command = 'cp /archive/%f %p'` and, for point-in-time, `recovery_target_time = '2026-11-20 16:00:00+00'` into `postgresql.conf` or `postgresql.auto.conf` in `DATADIR`, then start the server. For a standby, use `standby.signal` instead. `recovery.signal` is removed at the end.

```text
FATAL:  recovery ended before configured recovery target was reached
```

The archive ran out of WAL before the target time or LSN. The target is later than the last archived WAL, or segments are missing from the archive. Pick an earlier target or fix `restore_command`; check `pg_stat_archiver` on the old primary.

```text
FATAL:  recovery aborted because of insufficient parameter settings
DETAIL:  max_prepared_transactions = 0 is a lower setting than on the primary server, where its value was 5.
HINT:  You can restart the server after making the necessary configuration changes.
```

The restored server has a lower setting than the primary had when the backup was taken. Set it at least as high (also `max_connections`, `max_worker_processes`, `max_wal_senders`, `max_locks_per_transaction`) and start again.

```text
PANIC:  could not locate a valid checkpoint record
```

The data directory was started without its `backup_label`, or WAL is missing. A restored base backup must keep `backup_label` and have the WAL from the backup's start (`pg_basebackup -X stream` includes it). Never delete `backup_label` to make it start.

```sh
pgbackrest --stanza=STANZA check
pgbackrest --stanza=STANZA info
```

pgBackRest (a separate tool, 2.x). `check` proves that WAL archiving and the repository work end to end by archiving a segment; run it after any change. `info` lists backups and the WAL range: `status: ok`, **wal archive min/max** and the last **full backup** time. The user and config must be those of the Postgres host.

```text
ERROR: [068]: archive_command '/bin/false' must contain pgbackrest
```

`pgbackrest check` found `archive_command` is not the pgBackRest one, so WAL is not going to the repository. Set `archive_command = 'pgbackrest --stanza=STANZA archive-push %p'` and reload. Check the failures with `pg_stat_archiver`.

```sh changes
pgbackrest --stanza=STANZA --type=incr backup
```

Takes an incremental backup (`full` and `diff` also exist) and reads the live database, adding I/O load. With no full backup yet it takes a full one and warns. Repeated failures with the archive: fix `archive_command` before backing up.

### Config

```sql
SELECT name, setting, unit, source, pending_restart
FROM pg_settings WHERE pending_restart;
```

After a reload (`SELECT pg_reload_conf();`), the settings changed in the config files that need a restart to take effect. A row here means the server still runs the old value: `SHOW` and the config file disagree until you restart.

```sql
SELECT name, setting, source, sourcefile, sourceline
FROM pg_settings WHERE name IN ('max_connections', 'work_mem', 'shared_buffers');
```

The live value and where it comes from. Priority is command line, then `ALTER SYSTEM` (`postgresql.auto.conf`), then `postgresql.conf`; a `-c` flag in the service unit or Docker command beats `ALTER SYSTEM`, which then silently has no effect.

```sql
SELECT sourcefile, sourceline, name, setting, applied, error
FROM pg_file_settings WHERE error IS NOT NULL OR NOT applied;
```

Checks config files before or after a reload. A row with an **error** shows the file and line of a bad value; the rest of the file is still applied. Run it after editing, before `pg_reload_conf()`.

```text
LOG:  invalid value for parameter "work_mem": "99xx"
LOG:  configuration file "/var/lib/postgresql/data/postgresql.auto.conf" contains errors; unaffected changes were applied
```

A reload found a bad value; the old value stays. Fix the line shown by `pg_file_settings`. Remove a bad `ALTER SYSTEM` line by editing `postgresql.auto.conf` or with `ALTER SYSTEM RESET`. A bad value at startup stops the server.

```sql changes
ALTER SYSTEM SET log_lock_waits = on;
SELECT pg_reload_conf();
```

Writes the setting to `postgresql.auto.conf` and applies it without restart (only for settings that do not need one). Undo with `ALTER SYSTEM RESET log_lock_waits;` and another reload.

### PostgreSQL errors

```text
FATAL: sorry, too many clients already
```

`max_connections` reached. Count app instances times pool size. Put PgBouncer in front rather than raising the limit: each connection is a process with its own memory.

```text
FATAL: remaining connection slots are reserved
```

The same limit; only the reserved superuser slots remain (the line continues with the role it is reserved for).

```text
FATAL:  too many connections for role "DBUSER"
```

A per-role cap (`ALTER ROLE ... CONNECTION LIMIT`) is reached, even though the server has room. Check `rolconnlimit` in `pg_roles`; the database form says "too many connections for database".

```text
FATAL: no pg_hba.conf entry for host "192.0.2.10", user "app", database "app", SSL encryption
```

No rule matches this host, user, database and SSL mode. Rules match top to bottom and the first match wins. The "no encryption" variant means the client did not try TLS. Add a rule, then `pg_reload_conf()`.

```text
FATAL: password authentication failed for user
```

A wrong password, or the stored hash is md5 while `pg_hba.conf` asks for scram-sha-256: set `password_encryption`, then reset the password.

```text
connection to server at "HOST", port 5432 failed: Connection refused
```

The server is down, or `listen_addresses` is 'localhost'. Changing it needs a restart.

```text
FATAL:  database "nodb" does not exist
```

A typo in the database name, or the app points at the wrong server. List them with `\l`. Through PgBouncer the pooler says "no such database: nodb" instead.

```text
ERROR:  permission denied for table big
```

The role lacks a privilege. Check `\dp TABLENAME` and the role's membership; a new table needs `GRANT SELECT` again, or default privileges set with `ALTER DEFAULT PRIVILEGES`.

```text
ERROR:  cannot execute CREATE TABLE in a read-only transaction
```

Either you are on a standby (`pg_is_in_recovery()` is `t`), so writes must go to the primary, or `default_transaction_read_only` or `transaction_read_only` is on for the role or database. Check the connection target first.

```text
ERROR: deadlock detected
```

Two transactions locked the same rows in opposite orders. Lock in one consistent order and retry the loser; the server log has both queries.

```text
ERROR:  canceling statement due to lock timeout
```

`lock_timeout` ended a wait for a lock. The context line says which row and table. Find the holder with `pg_blocking_pids`. The migration or script can be retried once the holder is done.

```text
canceling statement due to statement timeout
```

`statement_timeout` hit: a slow query, or one stuck behind a lock (check `pg_blocking_pids`).

```text
ERROR:  canceling statement due to user request
```

Someone ran `pg_cancel_backend`, or pressed Ctrl-C in `psql`. Not a fault in itself: find who and why in the log.

```text
FATAL:  terminating connection due to administrator command
```

`pg_terminate_backend`, or the server shutting down, ended the session. During a shutdown or a failover every client sees this.

```text
FATAL:  terminating connection due to idle-in-transaction timeout
```

`idle_in_transaction_session_timeout` closed a session that sat in a transaction. The app opened a transaction and did nothing for too long: find the code path, or the pool that does not roll back on release.

```text
canceling statement due to conflict with recovery
```

On a replica: vacuum on the primary removed rows your query still needed. Turn on `hot_standby_feedback` (it then holds back vacuum on the primary) or raise `max_standby_streaming_delay`. Enable `log_recovery_conflict_waits` to log each wait. `pg_stat_database_conflicts` counts them by type.

```text
server closed the connection unexpectedly
```

The backend died (look for "terminated by signal 9" in the server log and the OOM killer in `dmesg`), or a firewall or load balancer dropped an idle connection. Enable TCP keepalives and cap the pool's connection lifetime.

```text
duplicate key value violates unique constraint "..._pkey"
```

Right after a restore: the sequence is behind the data. Run this after writers have stopped: `SELECT setval(pg_get_serial_sequence('TABLENAME', 'id'), max(id)) FROM TABLENAME;`

```text
WARNING:  page verification failed, calculated checksum 49085 but expected 28645
ERROR:  invalid page in block 1 of relation base/5/17321
```

Disk corruption: a data block does not match its checksum (data checksums are on by default from PostgreSQL 18, off before unless set at `initdb`). Stop the guessing: check the disk and `dmesg`, then restore the relation from a backup or standby. `pg_stat_database.checksum_failures` counts them; `pg_checksums --check` scans a stopped cluster.

```text
could not extend file: No space left on device
```

Disk full. Check `pg_wal` and replication slots before deleting anything, and never delete WAL files by hand.

```text
PANIC:  could not write to file "pg_wal/xlogtemp.NNN": No space left on device
```

The WAL disk is full, so the server crashes and may fail to start. Free space elsewhere on the volume (logs, old dumps) or grow the volume; never delete files in `pg_wal`. After it starts, find what retained WAL: an inactive slot or a failing archive command.

```text
FATAL:  data directory "/var/lib/postgresql/data" has invalid permissions
DETAIL:  Permissions should be u=rwx (0700) or u=rwx,g=rx (0750).
```

The data directory is more open than PostgreSQL allows, often after a restore or a copy. `chmod 700` it (and check the owner is the postgres user) and start again.

```text
FATAL:  lock file "postmaster.pid" already exists
HINT:  Is another postmaster (PID 48) running in data directory "/tmp/m"?
```

Either a server really runs there, or a crash left a stale `postmaster.pid`. Check the pid with `ps` first. Delete the file only when no postgres process uses that data directory; two servers on one directory corrupt it.

```text
ERROR:  out of shared memory
HINT:  You might need to increase "max_locks_per_transaction".
```

One transaction took more locks than the shared lock table holds, typically a transaction touching thousands of tables or partitions. Raise `max_locks_per_transaction` (restart needed) or touch fewer relations per transaction. PostgreSQL 14 to 16 print the setting without quotes.

```text
ERROR:  could not resize shared memory segment "/PostgreSQL.123" to 4194304 bytes: No space left on device
```

A parallel query needs more shared memory than `/dev/shm` offers, common in containers (Docker defaults to 64 MB). Raise `--shm-size` or set `max_parallel_workers_per_gather` to 0.

```text
the database system is starting up
```

Crash recovery is replaying WAL. Wait and watch the server log.

## MySQL and MariaDB

Most incidents are connections piling up, a lock held by a transaction nobody finished, or replication that stopped. Baselines are MySQL 8.0 and 8.4 LTS and MariaDB 10.11 and 11.4 LTS; a tag or the text says where an engine differs.

### Look first

```sh
mysqladmin -h HOST ping
```

"mysqld is alive" when the server answers. MariaDB 11 ships the tool as `mariadb-admin`, and the official 11.4 image has no `mysqladmin`.

```sql
SELECT VERSION(), @@version_comment, @@hostname, @@read_only;
```

The engine and release first: a MariaDB version ends in `-MariaDB`. Many commands below differ between MySQL 8.0, MySQL 8.4 and MariaDB. `read_only` 1 on the host you expected to write to explains error 1290.

```sql
SHOW FULL PROCESSLIST;
```

Every connection, what it runs and for how long. Many Sleep rows: a pool holding idle connections. Without the PROCESS privilege you only see your own threads.

```sql
SELECT id, user, host, db, command, time, state, left(info, 80) AS query
FROM information_schema.processlist
WHERE command <> 'Sleep' ORDER BY time DESC;
```

The same without the sleepers, longest first.

```sql
SELECT user, SUBSTRING_INDEX(host, ':', 1) AS client, COUNT(*) AS conns, SUM(command = 'Sleep') AS sleeping
FROM information_schema.processlist GROUP BY user, client ORDER BY conns DESC;
```

Who holds the connections. One client with hundreds of sleeping connections is a leaking pool.

```sql changes
KILL QUERY ID;
```

Stops the running statement; the client sees error 1317. It does not release locks held by a connection that is idle in a transaction: that needs `KILL ID;` below.

```sql changes
KILL ID;
```

Drops the connection and rolls back its open transaction, so its locks go. The client sees 2013 Lost connection. A transaction that changed millions of rows can take a long time to roll back.

### Connections

```sql
SHOW GLOBAL STATUS LIKE 'Threads_connected';
SHOW VARIABLES LIKE 'max_connections';
```

Connections against the limit (151 by default on both). Reaching it gives error 1040.

```sql
SHOW GLOBAL STATUS WHERE Variable_name IN ('Threads_connected', 'Threads_running', 'Max_used_connections', 'Aborted_connects', 'Aborted_clients', 'Connection_errors_max_connections');
```

**Max_used_connections** near the limit means it was reached. **Aborted_connects** counts failed attempts (bad password, handshake failure), **Aborted_clients** connections that ended without a clean close, **Connection_errors_max_connections** the 1040 refusals.

```sql changes
SET GLOBAL max_connections = 400;
```

Takes effect at once for new connections and is lost at restart. Each connection costs memory, so fix the pool first; a pool is a better fix than a bigger limit. MariaDB silently keeps a value below 10 at 10.

```sql changes mysql8.0+
SET PERSIST max_connections = 400;
```

Sets it now and writes it to `mysqld-auto.cnf` so it survives a restart. MariaDB has no `SET PERSIST` (syntax error 1064): edit the config file there.

```sql
SHOW GLOBAL VARIABLES WHERE Variable_name IN ('max_connections', 'max_user_connections', 'thread_cache_size', 'wait_timeout', 'max_connect_errors');
```

The limits in one view. **max_user_connections** 0 means no per-account cap; a cap gives error 1226.

```sql mysql8.0+
SELECT ROUND(100 * (SELECT variable_value FROM performance_schema.global_status WHERE variable_name = 'Threads_created')
 / (SELECT variable_value FROM performance_schema.global_status WHERE variable_name = 'Connections'), 2) AS pct_new_threads;
```

The share of connections that needed a new thread instead of a cached one. Above about 10 percent, raise `thread_cache_size` (9 on a default MySQL, 256 on MariaDB).

```sql mariadb10.11+
SELECT ROUND(100 * (SELECT variable_value FROM information_schema.global_status WHERE variable_name = 'Threads_created')
 / (SELECT variable_value FROM information_schema.global_status WHERE variable_name = 'Connections'), 2) AS pct_new_threads;
```

The same on MariaDB, which keeps status in `information_schema.global_status` (MySQL 8 does not have that table).

```sql changes mysql8.0+
TRUNCATE performance_schema.host_cache;
```

Clears the host cache, which unblocks a host that hit `max_connect_errors`. Use `FLUSH HOSTS;` on MariaDB; on MySQL 8.4 it is a syntax error, and before 8.0.23 it was the way.

```sql mysql8.0.22+
SELECT logged, prio, error_code, subsystem, left(data, 120) AS message
FROM performance_schema.error_log WHERE prio IN ('Error', 'Warning') ORDER BY logged DESC LIMIT 20;
```

The server's own error log as a table (MySQL 8.0.22+). Failed logins, aborted connections and disk problems show here with their `MY-` codes. MariaDB has no such table.

```sql
SHOW VARIABLES LIKE 'log_error';
```

A path is the file to tail. `stderr` or an empty value means the service log: `journalctl -u mysql`, `-u mysqld` or `-u mariadb`, or `docker logs` in a container.

### Locks

```sql
SELECT * FROM sys.innodb_lock_waits\G
```

Who blocks whom. **sql_kill_blocking_connection** is the statement that usually frees the lock; **sql_kill_blocking_query** does nothing to a blocker that is idle in a transaction. Works on MySQL and MariaDB.

```sql
SELECT waiting_pid, blocking_pid, wait_age_secs, locked_table, waiting_query, blocking_query
FROM sys.innodb_lock_waits;
```

The short form. A `blocking_query` of NULL or an old query means the blocker is idle with its transaction open: find that connection with the next queries.

```sql mysql8.0+
SELECT engine_transaction_id, object_name, index_name, lock_type, lock_mode, lock_status, lock_data
FROM performance_schema.data_locks;
```

Every lock InnoDB holds or waits for. **lock_status** WAITING is the victim, GRANTED the holder; **lock_data** is the key value. Replaces `information_schema.innodb_locks`, which MySQL 8 removed.

```sql mysql8.0+
SELECT * FROM performance_schema.data_lock_waits\G
```

One row per wait: the **REQUESTING_ENGINE_TRANSACTION_ID** waits for the **BLOCKING_ENGINE_TRANSACTION_ID**, with thread ids you can match to the processlist.

```sql mariadb10.11+
SELECT w.requesting_trx_id, w.blocking_trx_id, l.lock_table, l.lock_mode, l.lock_data
FROM information_schema.innodb_lock_waits w
JOIN information_schema.innodb_locks l ON l.lock_id = w.requested_lock_id;
```

MariaDB has no `performance_schema.data_locks`. It keeps the older `information_schema` tables: this joins each waiting request to the lock it wants.

```sql
SELECT id, user, time, state, left(info, 60) AS query
FROM information_schema.processlist WHERE state LIKE 'Waiting for%lock%';
```

**Waiting for table metadata lock** is a DDL, or a query queued behind one. The DDL is itself waiting for a transaction that read the table and never finished.

```sql mysql8.0+
SELECT object_schema, object_name, waiting_pid, blocking_pid, sql_kill_blocking_connection
FROM sys.schema_table_lock_waits;
```

Metadata-lock waits with the connection to kill, as `innodb_lock_waits` does for rows. Needs the `wait/lock/metadata/sql/mdl` instrument, which is on by default.

```sql mysql8.0+
SELECT object_type, object_schema, object_name, lock_type, lock_duration, lock_status, owner_thread_id
FROM performance_schema.metadata_locks WHERE object_type = 'TABLE' ORDER BY lock_status;
```

The raw metadata locks. The waiting `ALTER` shows **EXCLUSIVE** with status PENDING; the holder is a `SHARED_READ` or `SHARED_WRITE` owner that is usually idle. Match **owner_thread_id** to `performance_schema.threads`.

```sql changes mariadb10.11+
INSTALL SONAME 'metadata_lock_info';
SELECT thread_id, lock_mode, lock_type, table_schema, table_name FROM information_schema.metadata_lock_info;
```

MariaDB's equivalent needs this plugin loaded first (it persists across restarts). On MySQL `INSTALL SONAME` is a syntax error.

```sql changes
SET SESSION lock_wait_timeout = 5;
```

Run before a DDL on a busy table: it then gives up with error 1205 after 5 seconds instead of queueing every new query behind it. The default is 31536000 s (a year) on MySQL and 86400 on MariaDB.

```sql
SELECT @@innodb_lock_wait_timeout, @@lock_wait_timeout, @@innodb_rollback_on_timeout;
```

Row-lock waits end at 50 s by default with 1205. Metadata-lock waits follow `lock_wait_timeout`. With `innodb_rollback_on_timeout` off, only the statement is rolled back.

### Deadlocks

```sql
SHOW ENGINE INNODB STATUS\G
```

Read LATEST DETECTED DEADLOCK (both transactions, the locks each **HOLDS** and **WAITING FOR**, and which one was rolled back), then TRANSACTIONS for long lock waits and **History list length**.

```sql
SELECT name, count FROM information_schema.innodb_metrics WHERE name IN ('lock_deadlocks', 'lock_timeouts');
```

How many deadlocks and lock timeouts since startup, on both engines. Sample it twice: a rising **lock_deadlocks** means a pattern, not a one-off.

```sql changes
SET GLOBAL innodb_print_all_deadlocks = ON;
```

Writes every deadlock to the error log, not only the latest one. MariaDB logs it at once. On MySQL the message is a Note, so you also need `log_error_verbosity = 3`.

```sql changes mysql8.0+
SET GLOBAL log_error_verbosity = 3;
```

Includes Note-level lines in the error log, which `innodb_print_all_deadlocks` needs on MySQL ("Transactions deadlock detected, dumping detailed information"). Back to 2 when done, because 3 is noisy.

### Long transactions

```sql
SELECT t.trx_mysql_thread_id AS id, p.user, p.host, p.command, p.time AS idle_s,
       TIMESTAMPDIFF(SECOND, t.trx_started, NOW()) AS trx_age_s, t.trx_rows_modified, t.trx_state, left(p.info, 40) AS running
FROM information_schema.innodb_trx t JOIN information_schema.processlist p ON p.id = t.trx_mysql_thread_id
ORDER BY t.trx_started;
```

Open transactions with their connection. **command** Sleep and a large **trx_age_s** is an application that forgot to commit. **trx_state** LOCK WAIT is a waiter. Take the `id` to `KILL`.

```sql
SELECT trx_mysql_thread_id AS id, TIMESTAMPDIFF(SECOND, trx_started, NOW()) AS age_s, trx_state, trx_rows_locked, trx_rows_modified, trx_isolation_level
FROM information_schema.innodb_trx WHERE trx_started < NOW() - INTERVAL 60 SECOND ORDER BY trx_started;
```

Only transactions older than a minute. **trx_rows_modified** is how much a rollback has to undo.

```sql
SELECT name, count FROM information_schema.innodb_metrics WHERE name = 'trx_rseg_history_len';
```

The history list length: undo records of committed transactions waiting to be purged. A figure that only grows means an old transaction or snapshot is holding purge back (tens of thousands is worth a look, millions slows reads). Same number as **History list length** in `SHOW ENGINE INNODB STATUS`.

```sql mariadb10.11+
SHOW GLOBAL STATUS LIKE 'Innodb_history_list_length';
```

MariaDB also exposes the history list length as a status variable. Check the oldest `trx_started` in `information_schema.innodb_trx` to find what holds it.

### Buffer pool

```sql
SHOW GLOBAL STATUS WHERE Variable_name IN ('Innodb_buffer_pool_reads', 'Innodb_buffer_pool_read_requests', 'Innodb_buffer_pool_wait_free');
```

**reads** are requests that had to go to disk, **read_requests** all page requests. Hit rate is 1 minus reads over requests. A **wait_free** above 0 means no free pages: the pool is too small.

```sql mysql8.0+
SELECT ROUND(100 * (1 - r.v / q.v), 2) AS hit_pct
FROM (SELECT variable_value + 0 AS v FROM performance_schema.global_status WHERE variable_name = 'Innodb_buffer_pool_reads') r,
     (SELECT variable_value + 0 AS v FROM performance_schema.global_status WHERE variable_name = 'Innodb_buffer_pool_read_requests') q;
```

The hit rate since startup in percent. Above 99 is healthy for a warm server; judge it after the server has been up for a while, because it starts low.

```sql mariadb10.11+
SELECT ROUND(100 * (1 - r.v / q.v), 2) AS hit_pct
FROM (SELECT variable_value + 0 AS v FROM information_schema.global_status WHERE variable_name = 'Innodb_buffer_pool_reads') r,
     (SELECT variable_value + 0 AS v FROM information_schema.global_status WHERE variable_name = 'Innodb_buffer_pool_read_requests') q;
```

The same on MariaDB, which reads status from `information_schema.global_status`. A tiny or freshly started server can show odd values.

```sql
SELECT @@innodb_buffer_pool_size / 1048576 AS bp_mb;
```

The pool size. The default is 128 MB, far too small for a database server; on a dedicated host it is commonly set to half to two thirds of RAM.

```sql
SELECT object_schema, object_name, allocated, data, pages
FROM sys.innodb_buffer_stats_by_table ORDER BY pages DESC LIMIT 10;
```

Which tables fill the pool. It scans the whole pool, so run it sparingly on a large one.

### Slow queries and digests

```sql changes
SET GLOBAL slow_query_log = ON;
SET GLOBAL long_query_time = 1;
```

Logs statements over 1 s; new connections pick up the threshold. The log is off and the limit 10 s by default. `SET GLOBAL` is lost at restart: `SET PERSIST` keeps it on MySQL 8, MariaDB needs the config file. Summarise with `mysqldumpslow -s t` (`mariadb-dumpslow` on MariaDB) or pt-query-digest.

```sql
SHOW VARIABLES LIKE 'slow_query_log%';
```

Whether the log is on and where the file is. The Docker images do not ship `mysqldumpslow`; read the file with pt-query-digest instead.

```text
# Query_time: 0.300234  Lock_time: 0.000000 Rows_sent: 1  Rows_examined: 1
```

A slow-log header. **Rows_examined** far above **Rows_sent** is a missing index; **Lock_time** high is waiting on locks, not work.

```sql changes mysql8.0.14+
SET GLOBAL log_slow_extra = ON;
```

Adds fields such as `Errno`, `Bytes_sent`, `Read_*`, `Sort_*` and `Created_tmp_disk_tables` to every slow-log entry. MySQL also skips administrative statements unless `log_slow_admin_statements` is on; MariaDB logs them.

```sql changes mariadb10.11+
SET GLOBAL log_slow_verbosity = 'query_plan,explain';
```

MariaDB's equivalent: each slow-log entry gets the plan and the EXPLAIN output. `log_slow_extra` does not exist there.

```sql
SHOW VARIABLES LIKE 'performance_schema';
```

The digest views below need it ON. It is on by default in MySQL and OFF in MariaDB: there, set `performance_schema=ON` in the config and restart.

```sql
SELECT query, db, exec_count, err_count, warn_count, total_latency, avg_latency, rows_examined_avg, tmp_disk_tables, full_scan
FROM sys.statement_analysis LIMIT 10;
```

The worst statements by total time, with similar queries grouped (digests). **full_scan** `*` is a table scan; **err_count** and **tmp_disk_tables** point at errors and spilling sorts. Resets at restart.

```sql
SELECT query, exec_count, total_latency, no_index_used_count, no_index_used_pct, rows_examined
FROM sys.statements_with_full_table_scans LIMIT 10;
```

Statements that scanned a table, already sorted by **no_index_used_pct** (the latency columns are text, so do not sort on them). A high **no_index_used_pct** on a big table is the first index to add.

```sql
SELECT query, exec_count, errors, error_pct, warnings
FROM sys.statements_with_errors_or_warnings LIMIT 10;
```

Statements that fail often. Useful when an application retries silently and hides the errors.

```sql
SELECT digest_text, count_star, ROUND(sum_timer_wait / 1e12, 2) AS total_s, sum_rows_examined, sum_no_index_used
FROM performance_schema.events_statements_summary_by_digest ORDER BY sum_timer_wait DESC LIMIT 10;
```

The raw table behind the sys views. Timers are in picoseconds, hence the division. Literals are replaced by `?`, so one row covers every value.

```sql changes
TRUNCATE performance_schema.events_statements_summary_by_digest;
```

Clears the digest statistics, so the next reading covers only the period since. It changes no data.

```sql mysql8.0+
SELECT * FROM sys.schema_unused_indexes WHERE object_schema NOT IN ('performance_schema');
```

Indexes with no use since startup. Only trust it after a full business cycle of uptime, and never drop one that enforces a constraint.

```sql mysql8.0.18+
EXPLAIN ANALYZE SELECT ...;
```

Runs it and shows the actual time per step (`actual time=37.2..37.2 rows=1 loops=1`). The statement really executes, so use it on a SELECT. In plain `EXPLAIN`, type ALL is a full table scan.

```sql mariadb10.11+
ANALYZE SELECT ...;
```

MariaDB has no `EXPLAIN ANALYZE` (syntax error); `ANALYZE SELECT` runs the query and adds **r_rows** and **r_filtered**, the real counts next to the estimates. `ANALYZE FORMAT=JSON SELECT ...` gives the timings.

### Replication

```sql mysql8.0.22+
SHOW REPLICA STATUS\G
```

**Replica_IO_Running** and **Replica_SQL_Running** must both say Yes. Then read **Seconds_Behind_Source**, **Last_IO_Error** and **Last_SQL_Error**. MariaDB accepts the command but prints `Slave_IO_Running`, `Slave_SQL_Running` and `Seconds_Behind_Master`. Before 8.0.22: `SHOW SLAVE STATUS`.

```sh mysql8.0.22+
mysql -h HOST -u DBUSER -p -e "SHOW REPLICA STATUS\G" | grep -E "Running|Seconds_Behind|Last_(IO|SQL)_Err|Gtid|Auto_Position"
```

The fields that matter, on either engine. Asks for the password. **Seconds_Behind_Source** NULL with a broken thread is an error, not zero lag.

```sql mariadb10.11+
SHOW ALL SLAVES STATUS\G
```

MariaDB supports several replication connections; this adds **Connection_name** to each block. `SHOW REPLICA STATUS` shows the default one only.

```sql mysql8.4+
SHOW BINARY LOG STATUS;
```

The source's current binlog file and position, plus the executed GTID set. 8.4 removed `SHOW MASTER STATUS` (error 1064); 8.0 has only that name.

```sql
SHOW MASTER STATUS;
```

The same on MySQL 8.0 and on MariaDB (MariaDB 11.4 also accepts `SHOW BINLOG STATUS`). It is a syntax error on MySQL 8.4: use `SHOW BINARY LOG STATUS`.

```sql mysql8.0.22+
SHOW REPLICAS;
```

The replicas registered with this source. MySQL 8.0 before 8.0.22 and MariaDB use `SHOW SLAVE HOSTS`; 8.4 removed that name.

```sql mysql8.0+
SELECT worker_id, service_state, last_error_number, left(last_error_message, 150) AS error, last_applied_transaction
FROM performance_schema.replication_applier_status_by_worker;
```

Per-worker state of the SQL applier. The real error and the failed transaction are here when `Last_SQL_Error` only says "Coordinator stopped because there were error(s) in the worker(s)". MariaDB has this table with other columns (no `worker_id`), so the query is MySQL only.

```sql mysql8.0+
SELECT service_state, last_error_number, left(last_error_message, 150) AS error, received_transaction_set
FROM performance_schema.replication_connection_status;
```

The I/O side: is the replica connected to the source, the last connection error, and the GTIDs received so far.

```sql mysql8.0+
SELECT @@global.gtid_executed;
SELECT GTID_SUBTRACT('REPLICASET', 'SOURCESET');
```

Run the first on each server, then paste the replica's set as `REPLICASET` and the source's as `SOURCESET`. A non-empty result is **errant transactions**: writes that ran only on the replica, which block a clean failover.

```sql mariadb10.11+
SELECT @@gtid_slave_pos, @@gtid_current_pos, @@gtid_binlog_pos;
```

MariaDB GTIDs are domain-server-sequence (`0-1-10`). Compare the replica's `gtid_slave_pos` with the source's `gtid_binlog_pos`; `@@gtid_executed` does not exist there.

```sql danger mysql8.0.22+
STOP REPLICA;
SET GTID_NEXT = 'GTIDVALUE';
BEGIN;
COMMIT;
SET GTID_NEXT = 'AUTOMATIC';
START REPLICA;
```

Skips one failed transaction by committing an empty one with its GTID (take `GTIDVALUE`, form `UUID:N`, from `Last_SQL_Error`). The replica now differs from the source for those rows: repair them afterwards. `sql_replica_skip_counter` is the pre-GTID way.

```sql danger mariadb10.11+
STOP SLAVE;
SET GLOBAL sql_slave_skip_counter = 1;
START SLAVE;
```

Skips the next event group on a MariaDB replica, GTID mode included. The replica then differs from the source for those rows. Check `Last_SQL_Error` first, and compare the data afterwards.

```sql
SHOW BINARY LOGS;
```

The binlog files and sizes. A replica that is far behind needs the files it has not read yet, so check this before purging.

```sql danger
PURGE BINARY LOGS BEFORE NOW() - INTERVAL 3 DAY;
```

Deletes binlog files older than 3 days, which cannot be undone. Never purge past what the slowest replica still reads (`Source_Log_File`, `Master_Log_File` on MariaDB), or it fails with error 1236.

```sql
SHOW VARIABLES LIKE 'binlog_expire_logs_seconds';
```

How long binlogs are kept. The default is 2592000 (30 days) on MySQL and 0 (never) on MariaDB, though the Debian and Ubuntu packages and the Docker image set 10 days in `50-server.cnf`; `expire_logs_days` is the deprecated older setting.

```sql danger
SET GLOBAL binlog_expire_logs_seconds = 259200;
```

Keeps 3 days of binlogs and purges older ones on the next rotation. Purged files cannot be recovered, so check the slowest replica first. Keep it longer than the longest replica outage or backup interval you must survive.

### Group Replication

```sql mysql8.0+
SELECT member_host, member_state, member_role, member_version FROM performance_schema.replication_group_members;
```

**member_state** ONLINE is healthy. RECOVERING is catching up, UNREACHABLE means the others lost contact, ERROR needs the error log, and OFFLINE with an empty role is a member that left. One PRIMARY unless multi-primary.

```sql mysql8.0+
SELECT member_id, count_transactions_in_queue, count_transactions_checked, count_conflicts_detected, count_transactions_remote_in_applier_queue
FROM performance_schema.replication_group_member_stats;
```

**count_transactions_in_queue** growing on a member means it cannot certify or apply as fast as the group writes (flow control follows). **count_conflicts_detected** counts transactions rolled back by certification.

```sql mysql8.0+
SELECT channel_name, service_state FROM performance_schema.replication_applier_status;
```

`group_replication_applier` is ON on a joined member, and OFF on one that failed to join. `group_replication_recovery` runs only while a member is RECOVERING.

### Galera (MariaDB)

```sql mariadb10.11+
SHOW GLOBAL STATUS WHERE Variable_name IN ('wsrep_cluster_size', 'wsrep_cluster_status', 'wsrep_local_state_comment', 'wsrep_ready', 'wsrep_connected');
```

A healthy node says the expected size, **Primary**, **Synced**, `ON` and `ON`. **non-Primary** means this node lost quorum and refuses queries. Joining and Donor/Desynced are transitions.

```sql mariadb10.11+
SHOW GLOBAL STATUS WHERE Variable_name IN ('wsrep_flow_control_paused', 'wsrep_flow_control_sent', 'wsrep_flow_control_recv', 'wsrep_local_recv_queue', 'wsrep_local_recv_queue_avg');
```

Flow control. **wsrep_flow_control_paused** is the fraction of time replication was paused (near 0 is good); **wsrep_local_recv_queue** above `gcs.fc_limit` (default 16) makes this node ask the cluster to slow down, so find the slow node ([flow control](https://galeracluster.com/library/documentation/flow-control.html)).

```sql mariadb10.11+
SHOW GLOBAL STATUS WHERE Variable_name IN ('wsrep_local_cert_failures', 'wsrep_local_bf_aborts', 'wsrep_cert_deps_distance', 'wsrep_evs_state', 'wsrep_cluster_conf_id');
```

Conflicts and membership. Two nodes writing the same row make the loser fail with error 1213 even without a local deadlock; **wsrep_local_bf_aborts** counts those local transactions aborted by a replicated write.

```sql mariadb10.11+
SHOW GLOBAL VARIABLES LIKE 'wsrep_provider_options'\G
```

The provider settings in one long value, such as `gcs.fc_limit`, `gcache.size` and `evs.suspect_timeout`. Dynamic ones change at runtime: `SET GLOBAL wsrep_provider_options = 'gcs.fc_limit=64';` on 10.11. When the `wsrep_provider` plugin is loaded, as in the 11.4 image, that fails with error 1210 and each option is its own variable: `SET GLOBAL wsrep_provider_gcs_fc_limit = 64;`. `gcache.size` needs the config file and a restart.

```sh
cat /var/lib/mysql/grastate.dat
```

On a stopped node: the last `seqno` and **safe_to_bootstrap**. After a crash `seqno` is -1: run `galera_recovery` (or `mariadbd --wsrep-recover`) on each node for its position. Bootstrap only the most advanced node with `galera_new_cluster` (it refuses while `safe_to_bootstrap: 0`; set 1 there by hand), then start the others; bootstrapping a node that is behind loses transactions ([recovery](https://galeracluster.com/library/documentation/crash-recovery.html)).

### Backups

```sh
mysqldump --single-transaction --routines --triggers --events --set-gtid-purged=OFF -h HOST -u DBUSER -p DB > FILE
```

A consistent dump of InnoDB tables without locking them. It prompts for the password. `--set-gtid-purged=OFF` leaves the `GTID_PURGED` line out, which otherwise stops a restore onto a server that already has GTIDs. Add `--no-tablespaces` without the PROCESS privilege. MySQL only: on MariaDB drop `--set-gtid-purged=OFF`.

```sh mysql8.0.26+
mysqldump --single-transaction --source-data=2 --all-databases -u DBUSER -p > FILE
```

Writes the binlog file and position as a comment, to start a replica from this dump. At the start it takes a brief global read lock (`FLUSH TABLES WITH READ LOCK`): it waits for running queries to finish and stalls new ones meanwhile. `--master-data` is the old name: 8.4 still accepts it with a deprecation warning.

```sh mariadb10.11+
mariadb-dump --single-transaction --master-data=2 --gtid --all-databases -u DBUSER -p > FILE
```

MariaDB's tool. The dump carries `CHANGE MASTER TO MASTER_USE_GTID=slave_pos` and the `gtid_slave_pos` to start from. It takes no global read lock: MariaDB reads the binlog position from the snapshot. `--source-data` and `--set-gtid-purged` are rejected here.

```text
mysqlpump is deprecated and will be removed in a future version. Use mysqldump instead.
```

`mysqlpump` still ran in MySQL 8.0 with this warning (and needs `--set-gtid-purged` on a GTID server). It is gone from 8.4 ([release notes](https://dev.mysql.com/doc/relnotes/mysql/8.4/en/news-8-4-0.html)): use `mysqldump` or MySQL Shell.

```sh mysql8.0.21+
mysqlsh --js -h HOST -u DBUSER -p -e "util.dumpInstance('/backup/dump1', {threads: 4})"
```

MySQL Shell's parallel, consistent dump of the whole instance into an empty directory. It is faster than `mysqldump` on large data ([dump utilities](https://dev.mysql.com/doc/mysql-shell/8.4/en/mysql-shell-utilities-dump-instance-schema.html)). `util.dumpSchemas(['DB'], ...)` dumps one schema.

```sh mysql8.0.21+ changes
mysqlsh --js -h HOST -u DBUSER -p -e "util.loadDump('/backup/dump1', {threads: 4})"
```

Loads a Shell dump. The target needs `local_infile=ON` (`SET GLOBAL local_infile = ON`, switch it off afterwards) or the load stops at the start with an error that names it.

```sh mariadb10.11+
mariabackup --defaults-extra-file=FILE --backup --target-dir=/backup/full1
```

A hot physical backup of a MariaDB server. FILE holds `user=` and `password=` under `[mariabackup]` (mode 600): `--password` does not prompt, it needs the password on the command line. The account needs RELOAD, PROCESS, LOCK TABLES and, with binlogs on, BINLOG MONITOR. The binlog position lands in `mariadb_backup_binlog_info` (not `xtrabackup_binlog_info`). From 11.x the name is `mariadb-backup` ([overview](https://mariadb.com/kb/en/mariabackup-overview/)).

```sh mariadb10.11+
mariabackup --prepare --target-dir=/backup/full1
```

Applies the redo log so the backup is consistent. It changes the backup directory, not the server; run it before any restore.

```sh danger mariadb10.11+
mariabackup --copy-back --target-dir=/backup/full1
```

Restores into the datadir, which must be empty (`Original data directory /var/lib/mysql is not empty` otherwise) with the server stopped. Fix ownership to `mysql` afterwards.

```sh mysql8.0+
xtrabackup --defaults-extra-file=FILE --backup --target-dir=/backup/full1
```

Percona XtraBackup is the same idea for MySQL, with the account under `[xtrabackup]` in FILE: a hot physical backup, then `xtrabackup --prepare`, then `--copy-back` into an empty datadir. Use the release that matches the server ([docs](https://docs.percona.com/percona-xtrabackup/8.4/)).

```sh
mysqldump --single-transaction --column-statistics=0 -h HOST -u DBUSER -p DB > FILE
```

Needed when a MySQL 8.0 `mysqldump` talks to a MariaDB server: the default statistics query fails with "Unknown table 'COLUMN_STATISTICS'".

### Disk and temporary tables

```sh
df -h /var/lib/mysql && du -sh /var/lib/mysql/* | sort -h | tail -5
```

Free space and the biggest items in the data directory. Binlogs, the tmpdir and one large table are the usual three. Use `SHOW VARIABLES LIKE 'datadir'` if the path differs.

```sql
SELECT table_schema, table_name,
       round((data_length + index_length) / 1048576) AS mb
FROM information_schema.tables ORDER BY mb DESC LIMIT 10;
```

Largest tables. InnoDB's numbers are estimates.

```sql
SELECT table_schema, ROUND(SUM(data_length + index_length) / 1048576) AS mb
FROM information_schema.tables GROUP BY table_schema ORDER BY mb DESC;
```

The same per schema, in MB.

```sql
SHOW GLOBAL STATUS LIKE 'Created_tmp%';
```

**Created_tmp_disk_tables** against **Created_tmp_tables** is the share of temporary tables that spilled to disk. A high share means big sorts or `GROUP BY` without an index, or a low `tmp_table_size` / `max_heap_table_size` (16 MB by default).

```sql mysql8.0+
SHOW VARIABLES WHERE Variable_name IN ('internal_tmp_mem_storage_engine', 'temptable_max_ram', 'temptable_use_mmap', 'tmpdir');
```

MySQL's internal temporary tables use the TempTable engine, up to `temptable_max_ram` (1 GiB by default). Past it, 8.0 uses memory-mapped files in `tmpdir`; 8.4 has `temptable_use_mmap` off and goes to InnoDB temporary tables in the datadir. A full `tmpdir` gives error 3, shown below.

```text
Disk is full writing './binlog.000003' (OS errno 28 - No space left on device). Waiting for someone to free space... Retry in 60 secs. Message reprinted in 600 secs.
```

MySQL logs this (`MY-000035`) when the binlog cannot grow and then waits instead of crashing: writes stall. Free space (purge binlogs only if no replica needs them) and it carries on.

### Accounts

```sql
SELECT user, host, plugin FROM mysql.user;
```

Accounts and the hosts they may connect from.

```sql
SHOW GRANTS FOR 'DBUSER'@'HOST';
```

What an account may do. `'app'@'%'` and `'app'@'localhost'` are different accounts.

```sql mysql8.4+
SELECT plugin_name, plugin_status FROM information_schema.plugins WHERE plugin_name LIKE '%native%';
```

On 8.4 **mysql_native_password** is DISABLED by default, so accounts and old clients that use it fail with error 1524. It is still ACTIVE in 8.0, with a deprecation warning. MariaDB uses it as its default.

### MySQL and MariaDB errors: connecting and logging in

```text
ERROR 1040 (08004): Too many connections
```

`max_connections` reached. Look for Sleep connections from a leaking pool. One extra slot stays free for an account with CONNECTION_ADMIN or SUPER. MariaDB will not go below 10, so a test with 3 never fails.

```text
ERROR 1226 (42000): User 'app' has exceeded the 'max_user_connections' resource (current value: 1)
```

One account hit its own cap (`max_user_connections` or `CREATE USER ... WITH MAX_USER_CONNECTIONS`). Same text on MySQL and MariaDB. Raise it for that account or fix its pool.

```text
ERROR 1045 (28000): Access denied for user 'app'@'10.0.0.7' (using password: YES)
```

The account exists for another host: 'app'@'localhost' and 'app'@'%' are different users. `using password: NO` means the client sent none. localhost means the Unix socket; use 127.0.0.1 to force TCP.

```text
ERROR 1044 (42000): Access denied for user 'app'@'%' to database 'mysql'
```

Logged in, but no right on that schema. Check `SHOW GRANTS`. Not the same as 1045, which is the login.

```text
ERROR 1142 (42000): SELECT command denied to user 'app'@'10.0.0.7' for table 'user'
```

The account lacks that privilege on that table. MariaDB prints the table as `` `mysql`.`user` ``; MySQL prints only the table name.

```text
ERROR 1227 (42000): Access denied; you need (at least one of) the SUPER or SYSTEM_VARIABLES_ADMIN privilege(s) for this operation
```

A global setting needs more than the account has. MariaDB 11.4 names CONNECTION ADMIN here, MariaDB 10.11 `SUPER, CONNECTION ADMIN`.

```text
ERROR 2002 (HY000): Can't connect to local MySQL server through socket '/var/run/mysqld/mysqld.sock' (2)
```

The server is down, or the client looks for the socket at another path. (2) is no such file. MariaDB words it "local server".

```text
ERROR 2003 (HY000): Can't connect to MySQL server on 'HOST:3306' (111)
```

111 is refused: the server is down or `bind-address` is 127.0.0.1. 110 is a timeout: a firewall.

```text
ERROR 2005 (HY000): Unknown MySQL server host 'HOST' (-2)
```

The name does not resolve. Check DNS with `getent hosts` from the same machine.

```text
Host 'HOST' is blocked because of many connection errors; unblock with 'mysqladmin flush-hosts'
```

Error 1129. Often a load balancer health check opening TCP without speaking MySQL. Run `TRUNCATE performance_schema.host_cache` (`FLUSH HOSTS` before 8.0.23 and on MariaDB), raise `max_connect_errors`, fix the check. Not reproduced on loopback; text from the manual.

```text
ERROR 1130 (HY000): Host 'IP' is not allowed to connect to this MySQL server
```

No account matches that client host at all. Create the account for that host or `%`, or check skip-name-resolve against host names in the grants. Text from the manual.

```text
ERROR 1820 (HY000): You must reset your password using ALTER USER statement before executing this statement.
```

The password has expired. The `mysql` client in batch mode first says to use `--connect-expired-password`. MariaDB says "You must SET PASSWORD before executing this statement".

```text
ERROR 1524 (HY000): Plugin 'mysql_native_password' is not loaded
```

The account uses a plugin that MySQL 8.4 no longer loads by default. Re-enable it with `mysql_native_password=ON` in the config, or move the account to `caching_sha2_password`.

```text
ERROR 1290 (HY000): The MySQL server is running with the --read-only option so it cannot execute this statement
```

A write on a read-only server, often a replica after a failover. `--super-read-only` blocks root too. MariaDB says "MariaDB server" and has no `super_read_only`.

```text
ERROR 2006 (HY000): MySQL server has gone away
```

`wait_timeout` closed an idle connection (validate or recycle pooled connections sooner), a packet exceeded `max_allowed_packet`, or the server restarted (`SHOW GLOBAL STATUS LIKE 'Uptime'`). 2013 Lost connection has the same causes.

```text mysql8.0.24+
ERROR 4031 (HY000): The client was disconnected by the server because of inactivity. See wait_timeout and interactive_timeout for configuring this behavior.
```

MySQL 8.0.24 and later say this when an idle connection is cut. MariaDB shows only 2006 and logs "Got timeout reading communication packets". `Aborted_clients` rises either way.

```text
ERROR 2013 (HY000): Lost connection to MySQL server during query
```

The connection ended mid-statement: the server crashed or restarted, the statement was killed with `KILL ID` (not `KILL QUERY`), or a proxy dropped it. Look at the server error log for the restart time.

```text
ERROR 1317 (70100): Query execution was interrupted
```

The statement was stopped by `KILL QUERY`. The connection stays open.

```text
ERROR 3024 (HY000): Query execution was interrupted, maximum statement execution time exceeded
```

MySQL's time limit: the `MAX_EXECUTION_TIME(ms)` hint or `max_execution_time` ran out (SELECT only). MariaDB uses `max_statement_time` (error 1969 `Query execution was interrupted (max_statement_time exceeded)`) and ignores the hint.

### MySQL and MariaDB errors: statements and data

```text
ERROR 1205 (HY000): Lock wait timeout exceeded; try restarting transaction
```

Another transaction holds the row, often one left open and idle. Only the statement rolls back, not the transaction, unless `innodb_rollback_on_timeout` is on. Find the holder with `sys.innodb_lock_waits`.

```text
ERROR 1213 (40001): Deadlock found when trying to get lock; try restarting transaction
```

InnoDB rolled back one transaction; retry it. The details are under LATEST DETECTED DEADLOCK.

```text
ERROR 1114 (HY000): The table 'm' is full
```

Disk or tmpdir space, or a MEMORY table that reached `max_heap_table_size`. Check `df -h` and the data directory first, then the table's engine.

```text
ERROR 1062 (23000): Duplicate entry '1' for key 't.PRIMARY'
```

A unique key violated. MySQL 8 names the key as `table.index`; MariaDB prints `'PRIMARY'` alone. On a replica this is the classic stuck replication.

```text
ERROR 1054 (42S22): Unknown column 'nope' in 'field list'
```

A wrong column name, often after a migration that did not reach this server. MariaDB says `in 'SELECT'` instead of `in 'field list'`.

```text
ERROR 1146 (42S02): Table 'test.nope' doesn't exist
```

Wrong schema, wrong name, or a case mismatch (`lower_case_table_names` is 0 on Linux, so names are case-sensitive).

```text
ERROR 1049 (42000): Unknown database 'nodb'
```

The schema is missing: a typo, or a restore that dropped it. `SHOW DATABASES;` lists what exists.

```text
ERROR 1048 (23000): Column 'v' cannot be null
```

An INSERT or UPDATE put NULL in a NOT NULL column. Same text on both engines.

```text
ERROR 1406 (22001): Data too long for column 's' at row 1
```

A value longer than the column in strict mode (the default). Without strict mode it is cut silently with a warning, which hides bugs.

```text
ERROR 1264 (22003): Out of range value for column 'v' at row 1
```

The number does not fit the column type. An exhausted `AUTO_INCREMENT` column shows as error 1062 instead; `sys.schema_auto_increment_columns` (MySQL) shows the headroom.

```text
ERROR 1366 (22007): Incorrect integer value: 'abc' for column `test`.`t`.`v` at row 1
```

A wrong type in strict mode. MySQL prints the column as `'v'` (sqlstate HY000); MariaDB prints the full `` `test`.`t`.`v` ``. 1292 (incorrect date value) reads the same way.

```text
ERROR 1451 (23000): Cannot delete or update a parent row: a foreign key constraint fails
```

A child row still points at this one. The message names the constraint. The mirror error 1452 means an insert or update points at a parent that does not exist.

```text
ERROR 3730 (HY000): Cannot drop table 'par' referenced by a foreign key constraint 'chi_ibfk_1' on table 'chi'.
```

MySQL 8 refuses to drop a referenced table. MariaDB gives error 1451 for the same drop.

```text
ERROR 1071 (42000): Specified key was too long; max key length is 3072 bytes
```

An index over wide `utf8mb4` columns. Shorten it with a prefix, such as `col(100)`, or use a smaller column.

```text
ERROR 1093 (HY000): You can't specify target table 't' for update in FROM clause
```

MySQL cannot update a table from a subquery on the same table. Wrap the subquery in a derived table, or use a join.

```text
ERROR 1140 (42000): In aggregated query without GROUP BY, expression #1 of SELECT list contains nonaggregated column 'test.t.id'; this is incompatible with sql_mode=only_full_group_by
```

MySQL's default `ONLY_FULL_GROUP_BY` rejects it. MariaDB does not set that mode by default, so the same query runs there; check `@@sql_mode` when moving between them.

```text
ERROR 1064 (42000): You have an error in your SQL syntax; check the manual that corresponds to your MySQL server version for the right syntax to use near 'SLAVE STATUS' at line 1
```

On 8.4 the old replication names are gone: `SHOW SLAVE STATUS`, `SHOW MASTER STATUS`, `SHOW SLAVE HOSTS`, `START SLAVE`, `CHANGE MASTER TO` and `RESET MASTER`. Use `REPLICA`, `SOURCE`, `SHOW BINARY LOG STATUS` and `RESET BINARY LOGS AND GTIDS`.

```text
ERROR 1791 (HY000): Unknown EXPLAIN/ANALYZE format name: 'TREE'
```

MariaDB has no `EXPLAIN FORMAT=TREE`; use `ANALYZE FORMAT=JSON SELECT ...` there. MySQL has both TREE and `EXPLAIN ANALYZE`.

```text
ERROR 3 (HY000): Error writing file '/tmpdb/MLfd=37' (OS errno 28 - No space left on device)
```

The `tmpdir` filled up during a sort or temporary table. Free the space or point `tmpdir` at a bigger disk; look for runaway sorts in the processlist state (Sorting result, Creating tmp table).

```text
ERROR 1153 (08S01): Got a packet bigger than 'max_allowed_packet' bytes
```

A statement or row larger than `max_allowed_packet` (64 MB by default on 8.0). Raise it on the server and in the client, or the connection is dropped. Text from the manual; not reproduced here.

### MySQL and MariaDB errors: replication, backups and clusters

```text
Last_SQL_Errno: 1062   Last_SQL_Error: Coordinator stopped because there were error(s) in the worker(s). The most recent failure being: Worker 1 failed executing transaction 'UUID:13' at source log binlog.000003, end_log_pos 2028.
```

The SQL thread stopped on a duplicate key after a local write on the replica. The cause is in `replication_applier_status_by_worker`; skip with an empty transaction only after you know the data is the same. MariaDB shows the event and error directly.

```text
Last_IO_Errno: 1045   Last_IO_Error: Error connecting to source 'repl@HOST:3306'. This was attempt 1/10, with a delay of 60 seconds between attempts. Message: Access denied for user 'repl'@'IP' (using password: YES)
```

The replica cannot log in: the password changed or the account lacks the host. `Replica_IO_Running` stays Connecting. MySQL 8.0 prints `attempt 1/86400`; MariaDB logs `error connecting to master ... retry-time: 60 maximum-retries: 100000`.

```text
Last_IO_Errno: 13114   Last_IO_Error: Got fatal error 1236 from source when reading data from binary log: 'Cannot replicate because the source purged required binary logs. Replicate the missing transactions from elsewhere, or provision a new replica from backup.'
```

The source purged binlogs the replica still needed. Rebuild the replica from a backup or dump. MariaDB reports `Last_IO_Errno: 1236` with "Could not find GTID state requested by slave in any binlog files". Raise `binlog_expire_logs_seconds` afterwards.

```text
ERROR 3546 (HY000) at line 24: @@GLOBAL.GTID_PURGED cannot be changed: the added gtid set must not overlap with @@GLOBAL.GTID_EXECUTED
```

Restoring a dump that holds `SET @@GLOBAL.GTID_PURGED` onto a server that already ran transactions. Dump with `--set-gtid-purged=OFF`, or `RESET BINARY LOGS AND GTIDS` (8.4) on a scratch server first.

```text
mysqldump: Couldn't execute 'FLUSH TABLES': Access denied; you need (at least one of) the RELOAD or FLUSH_TABLES privilege(s) for this operation (1227)
```

`--single-transaction` flushes tables first on MySQL. Grant RELOAD (or FLUSH_TABLES). A second message about PROCESS and tablespaces goes away with `--no-tablespaces`. MariaDB's dump did not need RELOAD in a test.

```text
mariabackup: Error: missing required privilege PROCESS on *.*
```

The backup account lacks PROCESS. mariabackup also needs RELOAD and LOCK TABLES, and BINLOG MONITOR with binlogs on ("failed to execute query SHOW MASTER STATUS" without it).

```text
ERROR 1047 (08S01): WSREP has not yet prepared node for application use
```

This Galera node is not part of a Primary component: it lost quorum or has not synced. Check `wsrep_cluster_status` and `wsrep_local_state_comment`, then fix the network. If every node is non-Primary, bootstrap the most advanced one in place instead of restarting: `SET GLOBAL wsrep_provider_options = 'pc.bootstrap=YES';` on 10.11, `SET GLOBAL wsrep_provider_pc_bootstrap = ON;` with the 11.4 plugin.

```text
ERROR 3092 (HY000): The server is not configured properly to be an active member of the group. Please see more details on error log.
```

`START GROUP_REPLICATION` refused. The log gives the reason, such as "This member has more executed transactions than those present in the group", meaning errant local transactions. Other causes are missing GTID settings, binlog or server id.

## SQL Server

Most incidents are a blocked session, a transaction log that cannot truncate, memory or tempdb pressure, or a login that fails. Queries are for SQL Server 2019 and 2022 and run in `sqlcmd` or any T-SQL client; the DMVs need VIEW SERVER STATE.

### Connect and look first

```sh
sqlcmd -S HOST,PORT -U DBUSER -C
```

Prompts for the password, so it never sits on the command line; type `GO` to run a batch. `-C` trusts the server's self-signed certificate: without it ODBC 18 stops with "certificate verify failed: self-signed certificate". On Linux the tool is in `/opt/mssql-tools18/bin` (older installs: `/opt/mssql-tools/bin`). Add `-I` for queries that use XML methods.

```sql
SELECT SERVERPROPERTY('ProductVersion') AS version, SERVERPROPERTY('ProductUpdateLevel') AS cu, SERVERPROPERTY('Edition') AS edition;
```

The build, the cumulative update and the edition. Express caps memory and database size (10 GB); Web and Standard cap memory, which explains some pressure that nothing else does.

### Sessions and blocking

```sql
SELECT r.session_id, r.status, r.command, r.wait_type, r.wait_time, r.blocking_session_id, r.cpu_time, r.total_elapsed_time, DB_NAME(r.database_id) AS dbname, t.text
FROM sys.dm_exec_requests r CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) t
WHERE r.session_id <> @@SPID;
```

What runs now. **wait_type** is what each request waits for, **blocking_session_id** non-zero means it is blocked, and times are in milliseconds. A session that is not here is idle.

```sql
SELECT session_id, blocking_session_id, wait_type, wait_time, wait_resource
FROM sys.dm_exec_requests WHERE blocking_session_id <> 0;
```

Only the blocked requests. **LCK_M_X** with a `KEY: db:...` **wait_resource** is a row lock. A **blocking_session_id** of -2 is an orphaned distributed transaction and -4 a latch the engine cannot attribute.

```sql
SELECT DISTINCT r.blocking_session_id AS head_blocker
FROM sys.dm_exec_requests r
WHERE r.blocking_session_id > 0
  AND r.blocking_session_id NOT IN (SELECT session_id FROM sys.dm_exec_requests WHERE blocking_session_id <> 0);
```

The head of each blocking chain: a session that blocks others and is not blocked itself. It often has no row in `sys.dm_exec_requests` at all, because it is idle with an open transaction.

```sql
SELECT c.session_id, t.text
FROM sys.dm_exec_connections c CROSS APPLY sys.dm_exec_sql_text(c.most_recent_sql_handle) t
WHERE c.session_id = ID;
```

The last statement an idle blocker ran, usually the `UPDATE` after a `BEGIN TRAN` that never committed. `DBCC INPUTBUFFER(ID);` shows the same, and `DBCC OPENTRAN;` the oldest open transaction of the current database.

```sql changes
KILL ID;
```

Ends the session and rolls back its transaction. Its locks stay held until the rollback ends, which can take as long as the transaction ran, and a restart does not skip it. `KILL ID WITH STATUSONLY;` shows rollback progress; once it is done the answer is error 6106 "is not an active process ID". You cannot kill your own session (error 6104).

### Waits and pressure

```sql
SELECT TOP 10 wait_type, waiting_tasks_count, wait_time_ms, signal_wait_time_ms
FROM sys.dm_os_wait_stats
WHERE wait_type NOT IN ('SLEEP_TASK', 'SLEEP_SYSTEMTASK', 'LAZYWRITER_SLEEP', 'XE_TIMER_EVENT', 'XE_DISPATCHER_WAIT', 'REQUEST_FOR_DEADLOCK_SEARCH', 'CHECKPOINT_QUEUE', 'DIRTY_PAGE_POLL', 'SP_SERVER_DIAGNOSTICS_SLEEP', 'BROKER_TO_FLUSH', 'BROKER_TASK_STOP', 'QDS_PERSIST_TASK_MAIN_LOOP_SLEEP', 'QDS_ASYNC_QUEUE')
  AND wait_type NOT LIKE 'DISPATCHER%' AND wait_type NOT LIKE 'PVS%' AND wait_type NOT LIKE 'PWAIT%' AND wait_time_ms > 0
ORDER BY wait_time_ms DESC;
```

Where the server spent its waiting time since startup, with the idle waits removed. Sample it twice and compare, or reset it with `DBCC SQLPERF('sys.dm_os_wait_stats', CLEAR)`. On an idle server `SOS_WORK_DISPATCHER` and `LOGMGR_QUEUE` lead and mean nothing ([wait types](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-views/sys-dm-os-wait-stats-transact-sql)).

```text
PAGEIOLATCH_SH
```

Waiting to read a data page from disk. At the top it means slow storage or too little memory: check read stalls in `sys.dm_io_virtual_file_stats`, then missing indexes and scans.

```text
WRITELOG
```

Waiting for the transaction log to be written at commit. A slow log volume, or an application committing row by row. Fix the disk, or batch the commits.

```text
LCK_M_X
```

Waiting for an exclusive lock; the other `LCK_M_` waits are the same story with another lock mode (`LCK_M_U` update, `LCK_M_S` shared). Find the blocker with `blocking_session_id`.

```text
SOS_SCHEDULER_YIELD
```

A task used its CPU slice and is queued for the next. Many of these mean CPU pressure: **runnable_tasks_count** above 0 for long in `sys.dm_os_schedulers` confirms it. Look for the top statements by CPU.

```text
RESOURCE_SEMAPHORE
```

A query is waiting for a memory grant, usually a big sort or hash. The query below shows who waits and who holds the memory.

```text
ASYNC_NETWORK_IO
```

SQL Server has results ready and the client is not reading them: a slow application or a huge result set, not a server fault. Fetch fewer rows.

```sql
SELECT session_id, requested_memory_kb, granted_memory_kb, wait_time_ms
FROM sys.dm_exec_query_memory_grants WHERE grant_time IS NULL;
```

Queries still waiting for a grant. Rows here for more than a few seconds point at stale statistics or a missing index behind an oversized sort. Check `max server memory (MB)` in `sys.configurations`: 2147483647 means no cap.

### Queries and Query Store

```sql
SELECT TOP 10 qs.execution_count AS runs, qs.total_worker_time / 1000 AS cpu_ms, qs.total_elapsed_time / 1000 AS elapsed_ms, qs.total_logical_reads AS reads,
  SUBSTRING(st.text, qs.statement_start_offset / 2 + 1, (CASE WHEN qs.statement_end_offset = -1 THEN DATALENGTH(st.text) ELSE qs.statement_end_offset END - qs.statement_start_offset) / 2 + 1) AS stmt
FROM sys.dm_exec_query_stats qs CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st
ORDER BY qs.total_worker_time DESC;
```

The top statements by CPU since their plan was cached. Order by `total_logical_reads` for I/O. The cache empties on restart and under memory pressure, so it is a sample, not a history.

```sql
SELECT actual_state_desc, desired_state_desc, query_capture_mode_desc, current_storage_size_mb, max_storage_size_mb, readonly_reason
FROM sys.database_query_store_options;
```

Run in the database you care about. **actual_state_desc** READ_ONLY (see **readonly_reason**) means Query Store filled up or was set read-only; OFF means it was switched off. It is on by default for new databases in 2022, not in `master`.

```sql
SELECT TOP 10 qt.query_sql_text, SUM(rs.count_executions) AS runs, SUM(rs.count_executions * rs.avg_duration) / 1000 AS total_ms, MAX(rs.max_duration) / 1000 AS max_ms
FROM sys.query_store_query q
JOIN sys.query_store_query_text qt ON qt.query_text_id = q.query_text_id
JOIN sys.query_store_plan p ON p.query_id = q.query_id
JOIN sys.query_store_runtime_stats rs ON rs.plan_id = p.plan_id
GROUP BY qt.query_sql_text ORDER BY total_ms DESC;
```

The slowest statements in Query Store history, which survives restarts. Durations are microseconds, hence the division. Add a `WHERE rs.last_execution_time > DATEADD(hour, -1, SYSUTCDATETIME())` filter to see only the last hour.

```sql changes
ALTER DATABASE DB SET QUERY_STORE = ON (QUERY_CAPTURE_MODE = ALL);
```

Turns Query Store on and captures every statement. The default `AUTO` skips cheap queries, so a short test query never appears. `ALL` costs some overhead, so go back to `AUTO` after the investigation.

```sql
SELECT TOP 10 d.statement, d.equality_columns, d.inequality_columns, s.user_seeks, s.avg_user_impact
FROM sys.dm_db_missing_index_details d
JOIN sys.dm_db_missing_index_groups g ON g.index_handle = d.index_handle
JOIN sys.dm_db_missing_index_group_stats s ON s.group_handle = g.index_group_handle
ORDER BY s.user_seeks * s.avg_user_impact DESC;
```

Indexes the optimiser wished for. Treat them as hints, not as a list to create: several often overlap an existing index, and the numbers reset at restart.

### tempdb, log and backups

```sql
SELECT SUM(unallocated_extent_page_count) * 8 / 1024 AS free_mb, SUM(version_store_reserved_page_count) * 8 / 1024 AS version_store_mb,
       SUM(user_object_reserved_page_count) * 8 / 1024 AS user_mb, SUM(internal_object_reserved_page_count) * 8 / 1024 AS internal_mb
FROM tempdb.sys.dm_db_file_space_usage;
```

Who fills tempdb. Large **version_store_mb** is a long snapshot or read-committed-snapshot transaction (see `sys.dm_tran_active_snapshot_database_transactions`), **internal_mb** sorts and hashes spilling, **user_mb** temp tables. `sys.dm_db_session_space_usage` names the session.

```sql
SELECT name, recovery_model_desc, log_reuse_wait_desc FROM sys.databases;
```

Why the log cannot truncate. **LOG_BACKUP** in FULL recovery means no log backup was taken; NOTHING is fine. ACTIVE_TRANSACTION, REPLICATION, AVAILABILITY_REPLICA and ACTIVE_BACKUP_OR_RESTORE name the other holders ([error 9002](https://learn.microsoft.com/en-us/sql/relational-databases/errors-events/mssqlserver-9002-database-engine-error)).

```sql
DBCC SQLPERF(LOGSPACE);
```

Log size and percent used for every database. A log at 100 percent with **LOG_BACKUP** is error 9002 about to happen.

```sql changes
BACKUP LOG DB TO DISK = N'FILE';
```

Writes a log backup to FILE, which frees the inactive log in FULL recovery. Put it on a disk with room, not the full log volume, and keep it: it is now part of the restore chain. In a test it dropped the log from 100 to 20 percent used. Schedule it; switching to SIMPLE recovery loses point-in-time restore.

```sql
SELECT d.name, MAX(b.backup_finish_date) AS last_full
FROM sys.databases d LEFT JOIN msdb.dbo.backupset b ON b.database_name = d.name AND b.type = 'D'
GROUP BY d.name;
```

The last full backup per database from the msdb history. NULL means none is recorded. Use `b.type = 'L'` for the last log backup.

### Deadlocks

```sql
SELECT TOP 5 timestamp_utc, CAST(event_data AS xml) AS graph
FROM sys.fn_xe_file_target_read_file('system_health*.xel', NULL, NULL, NULL)
WHERE object_name = 'xml_deadlock_report' ORDER BY timestamp_utc DESC;
```

The `system_health` session records every deadlock graph without any setup. The **graph** XML names the victim process, both statements and the locked resources. Run it from `sqlcmd -I`, or XML methods fail with error 1934.

```sql changes
DBCC TRACEON(1222, -1);
```

Writes every deadlock, in readable text, to the error log until restart. `DBCC TRACESTATUS(-1)` lists the traces that are on. The victim of a deadlock gets error 1205.

### Always On availability groups

```sql
SELECT DB_NAME(database_id) AS dbname, synchronization_state_desc, synchronization_health_desc, is_suspended, suspend_reason_desc,
       log_send_queue_size, redo_queue_size, secondary_lag_seconds
FROM sys.dm_hadr_database_replica_states;
```

Per database and replica. **synchronization_health_desc** should be HEALTHY. A growing **log_send_queue_size** (KB) is the network or the secondary being slow to receive; **redo_queue_size** is the secondary behind in applying. Empty on a server that is not in an availability group.

```sql
SELECT ag.name AS ag_name, ar.replica_server_name, rs.role_desc, rs.connected_state_desc, rs.synchronization_health_desc
FROM sys.availability_groups ag
JOIN sys.availability_replicas ar ON ar.group_id = ag.group_id
JOIN sys.dm_hadr_availability_replica_states rs ON rs.replica_id = ar.replica_id;
```

Run it on the primary: a secondary shows only itself. Which replica is PRIMARY and whether each is CONNECTED. DISCONNECTED means a network, endpoint or cluster problem. The values for a real group come from the documentation: it was run only on a standalone server.

```sql changes
ALTER DATABASE DB SET HADR RESUME;
```

Resumes data movement on a secondary where it was suspended (**is_suspended** 1). On a database that is not in a group it fails with error 35242. Check **suspend_reason_desc** first.

### Error log

```sql
EXEC sp_readerrorlog 0, 1, N'Login failed';
```

Searches the current error log (0) of the SQL Server log (1; 2 is the Agent log) for the text. This is where the real reason for a failed login is. `EXEC sp_enumerrorlogs;` lists the archives.

```sql
EXEC xp_readerrorlog 0, 1, N'Login failed', N'DBUSER', NULL, NULL, N'desc';
```

Two search strings (both must match), an optional time range as the two NULLs, and a sort order. Use it to narrow to one account.

### SQL Server errors

```text
Login failed for user 'app'. (Microsoft SQL Server, Error: 18456)
```

The client never learns why, on purpose. The reason and a state number are in the error log, which `sp_readerrorlog` reads ([18456 states](https://learn.microsoft.com/en-us/sql/relational-databases/errors-events/mssqlserver-18456-database-engine-error)).

```text
Login failed for user 'app'. Reason: Password did not match that for the login provided. [CLIENT: IP]
Error: 18456, Severity: 14, State: 8.
```

State 8 is a wrong password, as seen in the log. Per the documentation, state 5 is an unknown login, 7 a disabled login with a wrong password ("An error occurred while evaluating the password"), 11 or 12 a valid login without access to the server, 38 or 40 a missing database, 58 SQL logins not allowed. A disabled login with the right password is error 18470, and one whose password must change is error 18488.

```text
Login failed for user 'app'. Reason: The account is disabled.
```

Error 18470, which the client sees too: the login exists but is disabled (`ALTER LOGIN DBUSER ENABLE`). A login that must change its password gets error 18488, "Reason: The password of the account must be changed".

```text
Cannot open database "DB" requested by the login. The login failed.
```

Error 4060: the login's default or requested database is offline, missing, or the user has no access. Check `sys.databases` for **state_desc**. Connect to `master` with `-d master`.

```text
Msg 1205, Level 13, State 51
Transaction (Process 71) was deadlocked on lock resources with another process and has been chosen as the deadlock victim. Rerun the transaction.
```

One side of a deadlock was rolled back; retry it. The graph is in `system_health`. A **lock timeout** is error 1222 "Lock request time out period exceeded" after `SET LOCK_TIMEOUT` expires.

```text
Msg 9002, Level 17, State 2
The transaction log for database 'lg' is full due to 'LOG_BACKUP' and the holdup lsn is (42:264:1).
```

The log cannot grow or truncate. The quoted reason is **log_reuse_wait_desc**: take a log backup for LOG_BACKUP, end the open transaction for ACTIVE_TRANSACTION. Also check free space on the disk and the file's max size. SQL Server 2019 ends the message after the reason; 2022 adds the holdup LSN.

```text
Msg 1105, Level 17, State 2
Could not allocate space for object 'dbo.x'.'PK__x' in database 'df' because the 'PRIMARY' filegroup is full due to lack of storage space or database files reaching the maximum allowed size.
```

A data file hit its cap or the disk is full. Check `sys.master_files` for **max_size** and free disk space; in tempdb look at who uses it.

```text
Msg 17886, Level 20
The server will drop the connection, because the client driver has sent multiple requests while the session is in single-user mode.
```

The text is from `sys.messages`. It points to a client driver or pool that resets a connection while a batch still runs, so look at the application and driver version, not the server.

```text
Msg 701, Level 19
There is insufficient system memory in resource pool 'default' to run this query.
```

The server could not get memory for a query. Look at memory grants, `max server memory (MB)` against the host's RAM, and the biggest consumers; a restart only hides a leak. Text from `sys.messages`.

```text
A connection was successfully established with the server, but then an error occurred during the login process. (provider: Shared Memory Provider, error: 0 - No process is on the other end of the pipe.) (Microsoft SQL Server, Error: 233)
```

A client-side error: the connection opened and the server closed it during login. The cause is usually a protocol or encryption mismatch, a server that is starting or overloaded, or a connection limit. Check the server error log at that time. Text from the documentation, not reproduced here.

```text
A transport-level error has occurred when sending the request to the server. (provider: TCP Provider, error: 0 - An existing connection was forcibly closed by the remote host.) (Microsoft SQL Server, Error: 10054)
```

A Windows socket error on the client: the other end, a firewall or a load balancer closed the TCP connection (an idle timeout is common), or the server dropped it. Compare the time with the error log and with idle timeouts on the network path. At the pre-login handshake ("an error occurred during the pre-login handshake") it is usually a TLS version or encryption mismatch.

```text
Violation of PRIMARY KEY constraint 'PK_t'. Cannot insert duplicate key in object 'dbo.t'. The duplicate key value is (1).
```

Error 2627, a duplicate in a unique key. The message names the constraint and the value. Error 2601 is the same for a unique index.

## SQLite

Most failures are a second writer ("database is locked"), a full or read-only disk, a WAL file that keeps growing, or a damaged file. Examples use the `sqlite3` shell, version 3.37 or later; `FILE` is the database path.

### Look first

```sh
sqlite3 --version
sqlite3 -readonly FILE "PRAGMA journal_mode; PRAGMA busy_timeout; PRAGMA synchronous; PRAGMA page_size; PRAGMA page_count; PRAGMA freelist_count; PRAGMA wal_autocheckpoint;"
```

The shell version, then the settings that explain most incidents, one value per line in that order. Defaults are `delete`, `0`, `2`, `4096`, the page count, `0` and `1000`. `-readonly` opens the file without being able to change it, which is safe for triage.

```sh
ls -la FILE*
fuser -v FILE
```

The database and its side files (`FILE-wal`, `FILE-shm`, `FILE-journal`), then every process with it open. A `-wal` file of hundreds of MB means checkpoints cannot finish. `lsof FILE` shows the same with file descriptors; both need root to see other users' processes.

```sh
sqlite3 -readonly FILE ".tables" ".indexes" ".schema"
```

What is in the file. `-readonly` keeps a typo from changing data. `.schema TABLENAME` limits the output to one table.

```sh
sqlite3 -readonly FILE "SELECT name, sum(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY bytes DESC;"
```

Space used per table and index (the `dbstat` module, present in most builds). A large index or table that should be small is a cleanup or bloat lead; free pages inside the file show in `PRAGMA freelist_count`.

```sh
sqlite3 -readonly FILE "PRAGMA database_list; PRAGMA user_version; PRAGMA foreign_keys;"
```

The real path of the file this process opened (a frequent surprise), the app's schema version marker, and whether foreign keys are enforced. `foreign_keys` is per connection and defaults to 0, so each connection must turn it on.

### Database is locked

```text
Error: stepping, database is locked (5)
```

Another connection holds a write lock, or a reader blocks a needed lock, and this one did not wait: `busy_timeout` is 0 in the shell, and many drivers default to a small value. Find the holder with `fuser -v FILE`, then set a timeout as below. The library's own text is "database is locked" (`SQLITE_BUSY`).

```sh
sqlite3 FILE ".timeout 5000" "BEGIN IMMEDIATE; ROLLBACK;"
```

Takes the write lock after waiting up to 5 seconds, then releases it without writing anything. `.timeout` in the shell, `PRAGMA busy_timeout = 5000;` from code. It applies to this connection only, so every connection in the app needs it. If the error remains after the wait, a writer holds the lock longer than that.

```text
Runtime error near line 2: database is locked (5)
```

In WAL mode, a transaction that started with a read (`BEGIN`, then `SELECT`) and then tries to write fails at once if another connection committed in between, and no timeout helps. Retry the whole transaction, and start writers with `BEGIN IMMEDIATE`.

```sh changes
sqlite3 FILE "PRAGMA journal_mode=WAL;"
```

Switches to write-ahead logging and prints `wal`. The mode is stored in the file and survives restarts. Readers no longer block the writer, but only one writer at a time is allowed, and every process must be on the same host: WAL does not work over network file systems. Undo with `PRAGMA journal_mode=DELETE;` while no one else is connected.

```sh
sqlite3 FILE "PRAGMA journal_mode;"
```

The mode now: `delete` (default), `wal`, `truncate`, `persist`, `memory` or `off`. `memory` and `off` give up rollback safety, so a crash can corrupt the file. If an app set them for speed, expect corruption after a power loss.

### WAL and checkpoints

```sh changes
sqlite3 FILE "PRAGMA wal_checkpoint(PASSIVE);"
```

Copies WAL frames into the database file without blocking anyone. It prints three numbers: **busy** (1 if it could not finish), the frames in the WAL, and the frames copied. `0|0|0` is an empty WAL. Frames copied below the total means readers still need old data.

```sh changes
sqlite3 FILE ".timeout 5000" "PRAGMA wal_checkpoint(TRUNCATE);"
```

Waits for writers and readers (up to 5 seconds with `.timeout 5000`; the shell default is 0), stalls new writers while it waits, copies everything and shrinks the `-wal` file to zero. Output `1|268|0` means it was blocked: a long read transaction holds an old snapshot, so the WAL cannot be reset and keeps growing. Find that process with `fuser -v FILE`. `RESTART` and `FULL` also exist.

```text
-rw-r--r-- 1 root root 1104192 Nov 20 16:19 app.db-wal
-rw-r--r-- 1 root root   32768 Nov 20 16:19 app.db-shm
```

The side files of a database in WAL mode while it is open. The `-shm` file is an index and is rebuilt on open, but the `-wal` file holds committed transactions not yet in the main file. Never delete or move a `-wal` file, or copy only the `.db`: you lose committed data. A clean close of the last connection checkpoints and removes both.

```text
FILE-journal
```

A `-journal` file left next to the database after a crash (rollback-journal mode) is a "hot journal": the next open rolls the partial transaction back. Keep it with the database; deleting it leaves a half-written file. Copying the database while a writer is active has the same problem.

### Integrity and corruption

```sh
sqlite3 FILE "PRAGMA quick_check;"
```

A fast structural check that does not verify index contents. It prints `ok` or a list of problems. Run it first on a big file; run `integrity_check` when it fails or when you suspect indexes.

```sh
sqlite3 FILE "PRAGMA integrity_check;"
```

The full check of structure and index consistency; it can take minutes on a large file. `ok` means healthy. Otherwise each line names a page and the fault, for example "Page 4: btreeInitPage() returns error code 11". `PRAGMA integrity_check(1)` stops at the first problem.

```text
Error: stepping, database disk image is malformed (11)
```

SQLite found pages that do not make sense: disk damage, a file copied while in use, a `-wal` deleted from a live database, or a power loss with `synchronous=OFF`. Stop the apps, copy the file with its `-wal` aside, then run `integrity_check` and recover as below.

```sh sqlite3.29+
sqlite3 FILE ".recover" | sqlite3 recovered.db
```

Reads every readable page of a damaged file and writes SQL to rebuild a new database; orphaned rows land in a `lost_and_found` table. Check the result with `PRAGMA integrity_check;` and compare row counts. Needs `dbpage` support in the shell: on "no such table: sqlite_dbpage", use the official build from sqlite.org. Never overwrite the original.

```text
ROLLBACK; -- due to errors
```

The last line of `.dump` output on a damaged file: the dump hit errors, so its SQL is incomplete and rolls back when loaded. Use `.recover` instead, which skips unreadable pages and keeps what it can.

```text
Error: in prepare, file is not a database (26)
```

The first 16 bytes are not the SQLite header: the path is not a database (a log, an HTML error page), the file is encrypted (SQLCipher), or it is damaged at byte 0. `head -c 15 FILE` should print `SQLite format 3`.

```sh
sqlite3 -readonly FILE "PRAGMA foreign_key_check;"
```

Rows that break a foreign key. Empty output means none. Run it after a restore or a recovery, because `.recover` does not check constraints.

### Open, write and disk errors

```text
Error: unable to open database "/srv/app/data.db": unable to open database file
```

The directory is missing, the path is wrong, or the user cannot reach it. A writer also needs write access to the directory itself, not only the file, for journal and WAL files. Check with `ls -ld "$(dirname FILE)"` and the process's user.

```text
Error: stepping, attempt to write a readonly database (8)
```

The file or its directory is not writable for this user, the file system is mounted read-only, or the connection was opened `-readonly`. In WAL mode the `-wal` and `-shm` files must be writable too. Check `ls -la FILE*` and `mount | grep MNT`.

```text
Error: stepping, database or disk is full (13)
```

No space on the volume holding the database or its temp files (large `VACUUM` and sorts use `TMPDIR`). The file is intact and the transaction in progress rolled back. Free space, then retry.

```sh
df -h MNT; df -i MNT
```

Space and inodes on the volume. A `VACUUM` needs about the size of the database again, plus a journal. If the disk is full of the WAL itself, find the long reader that blocks checkpoints.

```sh changes
sqlite3 FILE "VACUUM;"
```

Rebuilds the file and returns free pages to the OS, so it shrinks after big deletes. It needs free disk about the size of the database and blocks other writers while it runs. Worth it when `PRAGMA freelist_count` is a big part of `page_count`.

### Backup

```sh
sqlite3 FILE ".backup backup.db"
```

A consistent copy of a live database, taken through SQLite's backup API, safe while apps write. Use this, not `cp`, on a database in use. Check the copy with `PRAGMA integrity_check;`.

```sh sqlite3.27+
sqlite3 FILE "VACUUM INTO 'copy.db';"
```

Writes a compacted copy into a new file and leaves the source unchanged. The target must not exist. It reads the whole database and needs disk space for the copy.

```sh
sqlite3 FILE ".dump" > FILE.sql
```

All schema and data as SQL, restorable with `sqlite3 NEW.db < FILE.sql`. Slower and bigger than `.backup`, but portable and readable. On a damaged file it ends with `ROLLBACK`; see above.

## Redis

One command thread serves everyone, so a single slow command stalls every client. The commands work on Valkey too: use `valkey-cli` for `redis-cli`, `valkey-sentinel` for `redis-sentinel`, and `valkey-check-aof` for `redis-check-aof`.

### Connect and first look

```sh
read -rs REDISCLI_AUTH && export REDISCLI_AUTH && redis-cli -h HOST ping
```

PONG means up. `read -s` takes the password without echo and keeps it out of shell history; the variable keeps it out of `ps`. With `-a` every user on the host can see it. `redis-cli` also reads `REDISCLI_AUTH` for `--user`.

```sh
redis-cli INFO server | grep -E 'redis_version|valkey_version|redis_mode|uptime_in_seconds|config_file'
```

The version, the mode (`standalone`, `sentinel` or `cluster`), the uptime and the config file in use. A small `uptime_in_seconds` means it restarted: check the OOM killer and `dmesg`. Valkey prints `redis_version:7.2.4` for compatibility; read `valkey_version`.

```sh
redis-cli INFO memory
```

`used_memory_human` against `maxmemory_human`. `mem_fragmentation_ratio` above 1.5 is fragmentation; below 1 means the OS swapped part of Redis out.

```sh
redis-cli INFO clients
```

`connected_clients` and `blocked_clients`. `CLIENT LIST` shows each one.

```sh
redis-cli INFO stats | grep -E 'instantaneous_ops_per_sec|rejected_connections|evicted_keys|expired_keys|keyspace_hits|keyspace_misses|sync_full'
```

Rates and counters since start. `rejected_connections` above 0: `maxclients` was hit. `evicted_keys` rising: memory is full. `sync_full` rising: replicas keep doing full resyncs. A falling hit ratio, `keyspace_hits` over hits plus misses, means keys expire or get evicted early.

```sh
redis-cli INFO keyspace
```

Per database: `keys`, `expires` and `avg_ttl` in milliseconds. `expires` far below `keys` on a cache means keys never expire and memory only grows.

```sh
redis-cli INFO errorstats
```

A counter per error type since start, such as `errorstat_OOM:count=1`. It shows which refusals your clients are getting before you find them in an application log. `INFO commandstats` gives `calls`, `usec_per_call`, `rejected_calls` and `failed_calls` for each command.

### Memory and eviction

```sh
redis-cli CONFIG GET 'maxmemory*'
```

`maxmemory` 0 means no limit: Redis grows until the kernel kills it. `maxmemory-policy` decides what happens at the limit; `noeviction` refuses writes, and the `allkeys-` and `volatile-` policies delete keys.

```sh
redis-cli INFO stats | grep -E 'evicted_keys|expired_keys'
```

`evicted_keys` rising with the `allkeys-` or `volatile-` policies is the cache working as set, and each eviction can be a later cache miss. Under `volatile-` policies, keys without a TTL are never evicted, so writes can still fail with OOM.

```sh danger
redis-cli CONFIG SET maxmemory-policy allkeys-lru
```

Lets a full cache evict the least recently used keys instead of refusing writes. Use it only when every key can be rebuilt. It does not survive a restart: set it in the config file too.

```sh
redis-cli MEMORY DOCTOR
```

Plain-English findings, such as big client buffers or fragmentation. On a near-empty instance it only says there is too little data to judge. Treat it as a hint and confirm in `INFO memory`.

```sh
redis-cli MEMORY USAGE KEYNAME
```

Bytes for the key, its value and overhead. A missing key returns nil. For a large collection add `SAMPLES 0` to count every element instead of a sample; that is slower on a huge key.

```sh
redis-cli MEMORY STATS
```

A key and a value on alternate lines: `total.allocated`, `peak.allocated`, `clients.normal`, `clients.slaves`, `replication.backlog`. Normal and pub/sub client buffers count against `maxmemory`; replica buffers do not (`mem_not_counted_for_evict`) but still use RAM. A large `clients.slaves` means a replica is behind.

```sh
redis-cli --bigkeys -i 0.1
```

The biggest key per type. It uses SCAN, so it does not block like KEYS, but it walks the whole keyspace: `-i 0.1` pauses between batches, and on a busy primary it belongs on a replica. Element counts say little about bytes; use `--memkeys` for bytes.

```sh
redis-cli --memkeys -i 0.1
```

Like `--bigkeys` but it asks for the size in bytes of every key (`MEMORY USAGE`), so it costs more. The summary gives bytes per type and the biggest key of each.

```sh redis7.4+
redis-cli --keystats -i 0.1
```

One report for key sizes, key-name length and a percentile table by type. Redis 7.4 and later only: `valkey-cli` 8 rejects the option. It scans the whole keyspace, so run it on a replica.

```sh
redis-cli --scan --pattern 'user:*' --count 1000
```

Lists matching keys with SCAN instead of KEYS. Redis may still return keys in any order, and a key can show up twice. Pipe to `head` or `wc -l` rather than printing millions of names.

### Latency

```sh
redis-cli --latency
```

Round-trip latency, live. Spikes with a quiet SLOWLOG point to the fork for persistence, or the network.

```sh
redis-cli --latency-history -i 5
```

The same measure as `--latency`, one summary line every 5 seconds. Run it from the application host and from the Redis host: a gap between the two is the network, not Redis.

```sh
redis-cli --intrinsic-latency 5
```

Run on the Redis host itself. It measures the worst stall of the machine for 5 seconds with no Redis involved. A max of several milliseconds on an idle host means a noisy neighbour, steal time or a slow hypervisor.

```sh changes
redis-cli CONFIG SET latency-monitor-threshold 100
```

Turns on the latency monitor: any event slower than 100 ms is recorded. Zero means off. The cost is small. Events appear in `LATENCY LATEST`, such as `fork`, `command` and `eviction-cycle`.

```sh
redis-cli LATENCY LATEST
```

One block per event: the event name, the time of the latest spike, the latest spike in milliseconds and the maximum ever. `LATENCY HISTORY EVENT` lists the spikes for one event and `LATENCY GRAPH EVENT` draws them.

```sh
redis-cli LATENCY DOCTOR
```

Reads the monitor and says what it found: for `fork`, the fork rate in GB per second and what to do about it. It needs the latency monitor on: spikes from before `latency-monitor-threshold` was set are not in it.

```sh
redis-cli INFO latencystats
```

Per-command latency percentiles in microseconds, `p50`, `p99` and `p99.9`. Compare `p99` to `p50`: a wide gap points at a few slow calls, not a slow server. `LATENCY HISTOGRAM set` gives the buckets for one command.

```sh
redis-cli INFO stats | grep latest_fork_usec
```

How long the last fork took, in microseconds. The fork copies the page tables, so it grows with memory. A fork of hundreds of milliseconds stalls every client for that long; transparent huge pages make it worse.

```sh
redis-cli SLOWLOG GET 10
```

The slowest recent commands with their arguments. Each entry is an id, a Unix time, the duration in microseconds, the command, the client address and the client name. It leaves out time spent queued and on the network.

```sh changes
redis-cli CONFIG SET slowlog-log-slower-than 10000
redis-cli SLOWLOG LEN
```

Logs commands that run over 10000 microseconds (10 ms, the default); 0 logs everything and a negative value turns the log off. `SLOWLOG LEN` counts the entries; `slowlog-max-len` sets how many are kept. `SLOWLOG RESET` clears them.

```sh
timeout 5 redis-cli MONITOR | head -200
```

Streams every command and costs a large share of throughput. Seconds only, in production. Each line is a time, the database, the client address and the command with its arguments; arguments, including secrets, are printed in clear.

### Slow and blocking commands

```text
KEYS *
```

Blocks the command thread for the whole keyspace, and so does `SMEMBERS` on a big set, `HGETALL` on a big hash, `LRANGE 0 -1` and `SORT` on a long list. Use `SCAN`, `SSCAN`, `HSCAN` and ranges of a few hundred. Find the culprit in SLOWLOG and `INFO commandstats`.

```sh
redis-cli SCARD KEYNAME
redis-cli SSCAN KEYNAME 0 COUNT 100
```

`SCARD` is the set size and costs nothing. `SSCAN` returns a cursor, then members: pass the cursor back until it returns 0. A cursor of 0 on the first call means a small set returned whole. `HSCAN` and `ZSCAN` work the same way.

```sh danger
redis-cli UNLINK KEYNAME
```

Deletes the key and frees its memory in a background thread. `DEL` on a key with millions of elements blocks every client while it frees. Either one is gone for good, so check `TTL KEYNAME` and the name first.

```text
BUSY Redis is busy running a script. You can only call SCRIPT KILL or SHUTDOWN NOSAVE.
```

A Lua script has run longer than `busy-reply-threshold` (5000 ms by default; the old name is `lua-time-limit`), and every other client gets this error. A function started with FCALL says FUNCTION KILL instead. Valkey words it "Valkey is busy running a script".

```sh changes
redis-cli SCRIPT KILL
```

Stops the running script and answers OK. It works only if the script has not written anything yet; for a function use `FUNCTION KILL`. With nothing running, FUNCTION KILL answers `NOTBUSY No scripts in execution right now.`.

```text
UNKILLABLE Sorry the script already executed write commands against the dataset. You can either wait the script termination or kill the server in a hard way using the SHUTDOWN NOSAVE command.
```

The script has already written, and stopping it halfway would break atomicity. Wait if it will end. Otherwise `SHUTDOWN NOSAVE` is the only way out, and it loses every write since the last save.

```sh danger
redis-cli SHUTDOWN NOSAVE
```

Stops Redis at once without saving. With AOF on, the AOF is still flushed; with RDB only, every write since the last snapshot is lost. A replica promoted by Sentinel will have to be checked. Last resort for an UNKILLABLE script.

### Clients

```sh
redis-cli CLIENT LIST
```

One line per connection. **addr**: the peer. **age** and **idle**: seconds since connect and since the last command. **flags**: N normal, S replica, P pub/sub, b blocked, x in MULTI. **qbuf**: unparsed input bytes. **omem**: output buffer bytes. **cmd**: the last command. **name**: set by the client. **lib-name**, **lib-ver**: the client library, Redis 7.2+ and only when the library sends them.

```sh
redis-cli CLIENT LIST | awk '{for(i=1;i<=NF;i++){split($i,a,"=");v[a[1]]=a[2]} print v["omem"], v["addr"], v["cmd"], v["name"]}' | sort -rn | head
```

The connections with the biggest output buffers first. A large **omem** is a client that reads too slowly: a stuck subscriber, a replica behind, a script that asked for a huge reply.

```sh
redis-cli CLIENT LIST | awk '{split($2,a,"[=:]"); n[a[2]]++} END{for(i in n) print n[i], i}' | sort -rn | head
```

Connections per source address. One address with hundreds is a connection leak or a missing pool. Compare with `connected_clients` and `maxclients`.

```sh
redis-cli CLIENT INFO
```

The same fields, for your own connection only: the user, the db and the address the server sees.

```sh changes
redis-cli CLIENT KILL id ID
```

Closes the connection with that **id**, taken from `CLIENT LIST`. The keyword `id` is in lower case so that only the number is a blank. It answers 1 if it found one and 0 if not. A well-behaved client reconnects, so fix the cause too. `CLIENT KILL TYPE pubsub` closes every subscriber.

```sh
redis-cli CONFIG GET client-output-buffer-limit
```

Three classes: `normal`, `slave` (a replica) and `pubsub`, each with a hard limit, a soft limit and the seconds the soft limit may be exceeded, in bytes. A client that passes the hard limit, or stays over the soft one, is closed. Normal and pub/sub buffers count against `maxmemory`; replica buffers do not but still use RAM.

```text
Client id=3 addr=127.0.0.1:58276 laddr=127.0.0.1:6379 ... flags=P ... omem=114712 ... scheduled to be closed ASAP for overcoming of output buffer limits.
```

The server closed a client for an output buffer over its limit. **flags=P** is a subscriber that is too slow; **flags=S** is a replica. For a subscriber, make it read faster or publish less. For a replica, see the full resync loop under Replication.

```sh
redis-cli CONFIG GET maxclients
redis-cli INFO stats | grep rejected_connections
```

`maxclients` defaults to 10000, lowered if the process limit on open files is lower. `rejected_connections` counts every refused connection. Raise `ulimit -n` (`LimitNOFILE` in the unit) before raising `maxclients`.

### Persistence

```sh
redis-cli INFO persistence
```

`rdb_last_bgsave_status` and `aof_last_write_status` must read ok. `rdb_changes_since_last_save` is the data a crash would lose; `loading:1` means it is reading a dump; `rdb_last_cow_size` is the memory copied during the last fork.

```sh
redis-cli INFO persistence | grep -E '^(rdb_bgsave_in_progress|rdb_last_save_time|rdb_last_bgsave_status|aof_enabled|aof_rewrite_in_progress|aof_last_bgrewrite_status|aof_last_write_status)'
redis-cli LASTSAVE
```

The status of RDB and AOF in one view. `LASTSAVE` is the Unix time of the last good snapshot: compare with `date +%s`. A status of err means the write failed; the server log says why.

```sh changes
redis-cli BGSAVE
```

Forks and writes a snapshot in the background. It answers `Background saving started`; poll `rdb_bgsave_in_progress` and then `rdb_last_bgsave_status`. The fork can stall clients and needs spare memory for copy-on-write.

```sh changes
redis-cli BGREWRITEAOF
```

Rewrites the AOF into a compact form in the background. Use it when the AOF has grown huge: check the size of the `appendonlydir` folder. It forks like BGSAVE. In Redis 7 the files are in the `appendonlydir` folder: a manifest, a base file and one or more incr files.

```text
MISCONF Redis is configured to save RDB snapshots, but it's currently unable to persist to disk. Commands that may modify the data set are disabled, because this instance is configured to report errors during writes if RDB snapshotting fails (stop-writes-on-bgsave-error option). Please check the Redis logs for details about the RDB error.
```

The background save failed: disk full, permissions, a read-only filesystem, or the fork was refused memory (set `vm.overcommit_memory = 1`). The log has the cause, such as `Failed opening the temp RDB file ... Read-only file system`. Writes are refused until a save succeeds. Valkey says "Valkey is configured".

```sh danger
redis-cli CONFIG SET stop-writes-on-bgsave-error no
```

Lets writes through while snapshots keep failing. It hides the problem: the data is then not being saved. Use it only for minutes while you free disk, then set it back to yes and run `BGSAVE`.

```sh danger
redis-check-aof --fix DATADIR/appendonlydir/appendonly.aof.manifest
```

Run it with Redis stopped, on a copy. It reports the bytes it cannot read, such as `Expected \r\n` and `diff=22`, and asks before it truncates the file, which drops the damaged tail. Without `--fix` it only checks. The manifest file name follows `appendfilename`. Redis 7 starts anyway after a short read if `aof-load-truncated` is yes (the default).

### Replication

```sh
redis-cli INFO replication
```

The role, connected replicas, and `master_link_status` on a replica. On a primary, each `slaveN` line has the replica **state** (`online`, `wait_bgsave`), **offset** and **lag** in seconds. Valkey keeps the `master_` and `slave` field names.

```sh
redis-cli ROLE
```

A primary answers `master`, its offset and one entry per replica: address, port and offset. A replica answers `slave`, the primary's host and port, the link state (`connect`, `sync`, `connected`) and its offset. Same data as INFO, shaped for scripts.

```sh
redis-cli INFO replication | grep -E 'role|master_link_status|master_last_io_seconds_ago|master_sync_in_progress|master_link_down_since_seconds|slave_repl_offset|master_repl_offset'
```

On a replica: `master_link_status:up` and a small `master_last_io_seconds_ago` are healthy. `master_link_down_since_seconds` says how long the link has been down. Compare its `slave_repl_offset` with the primary's `master_repl_offset`: the difference is how many bytes it is behind.

```sh
redis-cli INFO stats | grep -E 'sync_full|sync_partial_ok|sync_partial_err'
```

On the primary: how many full resyncs, partial resyncs that worked and partial resyncs refused since start. A healthy fleet has few full ones. A `sync_full` that climbs by the minute is a resync loop.

```text
MASTER <-> REPLICA sync started
Partial resynchronization not possible (no cached master)
Full resync from master: ...:0
MASTER <-> REPLICA sync: Finished with success
```

Replica log of a full resync, from the start to success. The replica threw away its data and loaded a snapshot, which is normal on first connect and abnormal on every reconnect. Valkey says `PRIMARY <-> REPLICA` and "primary".

```text
Trying a partial resynchronization (request ...:1).
Successful partial resynchronization with master.
```

Replica log after a short disconnect: it asked to carry on from its offset and the primary still had the missing writes in the backlog. The primary logs `Partial resynchronization request from ... accepted`. This is the cheap path.

```text
Unable to partial resync with replica 172.19.0.3:6379 for lack of backlog (Replica request was: 15).
```

Primary log. The replica was away longer than the backlog could cover, so the primary falls back to a full resync, and `sync_partial_err` goes up. Raise `repl-backlog-size` to cover the longest outage at your write rate (`master_repl_offset` growth per second).

```text
Client id=5 addr=172.19.0.3:54306 ... flags=S ... cmd=psync ... scheduled to be closed ASAP for overcoming of output buffer limits.
```

The full resync loop. While the primary saves a snapshot it buffers new writes for the replica. If that buffer passes `client-output-buffer-limit replica`, the primary drops the replica, which reconnects and starts again, with the same result.

```text
Connection with replica 172.19.0.3:6379 lost.
Replica 172.19.0.3:6379 asks for synchronization
Full resync requested by replica 172.19.0.3:6379
Can't attach the replica to the current BGSAVE. Waiting for next BGSAVE for SYNC
```

The primary side of the same loop, repeated every few seconds, with `I/O error reading bulk count from MASTER` on the replica. Each round forks. Check `INFO stats` `sync_full` and CPU on the primary. Raise the replica buffer limit, then watch it stop.

```sh changes
redis-cli CONFIG SET client-output-buffer-limit "replica 512mb 128mb 60"
```

Breaks the resync loop when write traffic outruns the snapshot transfer: hard limit 512 MB, soft limit 128 MB for 60 seconds. The replica buffer does not count against `maxmemory` but still uses RAM (replicas share one buffer since Redis 7.0), so leave headroom. Also lower the write rate during the sync if you can.

```sh changes
printf 'SET triage:wait 1\nWAIT 1 1000\nDEL triage:wait\n' | redis-cli -h HOST
```

The write and the WAIT must share one connection, so this writes a probe key `triage:wait`, waits, and deletes it. The number is the replicas that acknowledged the write within 1 second (0 = behind or down). It makes a write safer, but it is not a guarantee of durability.

```sh danger
redis-cli -h HOST REPLICAOF NO ONE
```

Promotes the replica at HOST to primary. Promoting by hand next to Sentinel or Cluster causes split-brain: stop the old primary first, and prefer `SENTINEL failover`.

```sh danger
redis-cli -h HOST REPLICAOF IP PORT
```

Points the node at HOST to the primary at IP. It throws away the node's dataset for a full resync, so check which node HOST is before you run it.

```text
MASTERDOWN Link with MASTER is down and replica-serve-stale-data is set to 'no'.
```

A replica with `replica-serve-stale-data no` answers nothing while its link to the primary is down. Check `master_link_status` and the log line `Unable to connect to MASTER`: DNS, firewall, `masterauth`. Setting it to yes serves stale reads.

```sh
redis-cli INFO replication | grep -E 'connected_slaves|^slave[0-9]'
redis-cli CONFIG GET 'min-replicas-*'
```

`min-replicas-to-write` and `min-replicas-max-lag` make the primary refuse writes when too few replicas are online. Writes fail with NOREPLICAS when `connected_slaves` is lower than the first, or every lag is above the second.

### Sentinel

```sh
redis-cli -p 26379 SENTINEL get-master-addr-by-name mymaster
```

Sentinel listens on port 26379 and these commands go to a Sentinel, not to Redis. The address clients are told to use for the master named `mymaster` (use your own name). Run it against every Sentinel: all must agree. An empty answer means that name is unknown to this Sentinel. With `announce-hostnames yes` it returns a host name, not an IP.

```sh
redis-cli -p 26379 SENTINEL masters
```

A key and a value on alternate lines. **flags**: `master`, plus `s_down` (this Sentinel cannot reach it) or `o_down` (a quorum agrees). **num-slaves**, **num-other-sentinels**, **quorum**, **last-ok-ping-reply** and **down-after-milliseconds** say how it is seen.

```sh
redis-cli -p 26379 SENTINEL master mymaster | paste - -
```

The same fields as `SENTINEL masters`, one `name value` pair per line, which is easy to grep. An unknown name answers `ERR No such master with that name`. Look at **config-epoch**: it rises with each failover.

```sh
redis-cli -p 26379 SENTINEL ckquorum mymaster
```

`OK 3 usable Sentinels. Quorum and failover authorization can be reached` means a failover can start. `NOQUORUM` means too few Sentinels are reachable for the quorum, or for the majority that must authorise a failover.

```sh
redis-cli -p 26379 SENTINEL replicas mymaster
redis-cli -p 26379 SENTINEL sentinels mymaster
```

The replicas and the other Sentinels this one knows. Look at **flags**: `s_down` or `disconnected` on a replica, `s_down,sentinel` on a Sentinel. A replica with a long **master-link-down-time** or a priority of 0 will not be promoted.

```sh
redis-cli -p 26379 INFO sentinel
```

`master0:name=mymaster,status=ok,address=...,slaves=1,sentinels=3`. `status=sdown` or `odown` marks a master seen down. `sentinels` below the number you run means a Sentinel cannot be seen. `sentinel_tilt:1` means it paused its decisions after a long stall.

```text
+sdown master mymaster p 6379
+odown master mymaster p 6379 #quorum 3/2
+try-failover master mymaster p 6379
+elected-leader master mymaster p 6379
+promoted-slave slave 172.19.0.3:6379 172.19.0.3 6379 @ mymaster p 6379
+switch-master mymaster p 6379 172.19.0.3 6379
```

A failover in the Sentinel log. `+sdown` is one Sentinel, `+odown` a quorum, then a leader is elected, a replica is promoted and `+switch-master` gives the old and new address. A `-sdown` line later means the node came back; Sentinel turns the old master into a replica.

```sh danger
redis-cli -p 26379 SENTINEL failover mymaster
```

Starts a failover without a quorum vote, and demotes the current master. Clients see errors for a few seconds. With no healthy replica it answers `NOGOODSLAVE No suitable replica to promote` and nothing happens. Check `SENTINEL replicas` first.

### Cluster

```sh
redis-cli CLUSTER INFO
```

Each node also uses a bus port, the data port plus 10000 (16379); blocked bus ports stop the cluster forming. `cluster_state:ok` is healthy; `fail` means some hash slots are uncovered or a majority is lost. **cluster_slots_ok**, **cluster_slots_pfail** and **cluster_slots_fail** add up to **cluster_slots_assigned**; below 16384 means some slots have no owner. **cluster_known_nodes** and **cluster_current_epoch** should match on every node.

```sh
redis-cli CLUSTER NODES
```

One line per node: id, `address@bus-port`, flags (`myself`, `master`, `slave`, `fail?`, `fail`, `handshake`), its primary's id, the link state and the slot ranges. A `fail` flag is agreed by a majority, `fail?` is one node's suspicion. `[12182->-ID]` is a slot being migrated away.

```text
e6557afcefde... 172.19.0.4:6379@16379 master,fail - 1795191160271 1795191159260 3 connected 10923-16383
```

A node marked failed. Its slots stay unserved until a replica takes over, or the node returns. Without replicas, `cluster_state` goes to `fail` and every command returns CLUSTERDOWN. The log says `Marking node ... as failing (quorum reached)`.

```sh
redis-cli --cluster check HOST:PORT
```

Checks every node: `[OK] All nodes agree about slots configuration` and `[OK] All 16384 slots covered`. It warns about open slots (`has slots in migrating state`), uncovered slots and nodes that disagree. Read the output for `[ERR]` and `[WARNING]` lines.

```sh
redis-cli --cluster info HOST:PORT
```

Per primary: key count, slot count and number of replicas. A node with no replicas has no failover. A very uneven key count means a hot slot or a poor key design; `CLUSTER KEYSLOT KEYNAME` shows where a key lands.

```sh danger
redis-cli --cluster fix HOST:PORT
```

Tries to repair open slots and uncovered slots, and moves slot ownership and keys. Read `--cluster check` first and know why a migration stopped. In a test it finished a half-done slot migration by moving the slot to the importing node.

```sh
redis-cli -c -h HOST -p PORT
```

`-c` makes the client follow MOVED and ASK redirects. Without it, a key on another node returns the redirect as an error. Applications need a cluster-aware client; a plain client sees MOVED on most keys.

```text
MOVED 12182 172.19.0.4:6379
```

The key's hash slot (12182) lives on another node. Normal after a slot moves. A cluster client refreshes its slot map and retries. If you see it often, the client is not cluster-aware or its map is stale.

```text
ASK 12182 172.19.0.3:6379
```

The slot is moving: this node no longer has the key, but the target might. The client sends `ASKING`, then the command, to the target, once. Unlike MOVED it does not change the map. A migration stuck forever shows as open slots in `--cluster check`.

```text
CROSSSLOT Keys in request don't hash to the same slot
```

A multi-key command (MSET, a Lua script, MULTI) used keys from different slots. Give related keys a shared hash tag, such as `{user:42}:cart` and `{user:42}:profile`: only the part in braces is hashed.

```text
CLUSTERDOWN The cluster is down
```

`cluster_state` is `fail`: some slots have no reachable owner and `cluster-require-full-coverage` is yes. Find the failed node in `CLUSTER NODES`. With the setting no, nodes keep serving the slots they own, and only commands for lost slots fail.

```text
ERR This instance has cluster support disabled
```

A cluster command went to a node started without `cluster-enabled yes`. Check the address: it may be a standalone node, or the wrong port.

### ACL

```sh
redis-cli ACL WHOAMI
redis-cli ACL LIST
```

`ACL WHOAMI` is the user of this connection. `ACL LIST` shows each user's rules, such as `on #hash ~app:* -@all +get`: key patterns after `~` and commands after `+` and `-`. Passwords show as a hash, never in clear. The hashes are unsalted SHA-256, so do not paste the output.

```sh
redis-cli ACL LOG 10
```

The latest refused commands and failed logins, newest first. **reason**: `auth`, `command`, `key` or `channel`. **object**: the command, key or channel. Also **username**, **client-info**, **age-seconds** and **count** for repeats. Start here for a NOPERM or WRONGPASS.

```sh changes
redis-cli ACL LOG RESET
```

Clears the log, so new failures stand out after you fix a rule. `acllog-max-len` (128 by default) sets how many entries are kept; the oldest drop first.

```sh
redis-cli ACL GETUSER DBUSER
```

One user's flags (`on`, `nopass`), password hashes (unsalted SHA-256: do not paste the output), command rules, `keys` and `channels` patterns. A user with `-@all +get` can read, but `CONFIG GET` and `ACL WHOAMI` fail with NOPERM. The `default` user with `nopass` means no login is needed.

### TLS

```sh
redis-cli --tls --cacert /etc/redis/tls/ca.crt --cert /etc/redis/tls/client.crt --key /etc/redis/tls/client.key -h HOST -p PORT PING
```

PONG means the handshake and the certificate chain are fine. The cert and key are needed only when the server has `tls-auth-clients yes` (the default). `redis-cli` checks the chain but not the host name, so a pass does not prove the name is on the certificate.

```text
Could not connect to Redis at HOST:6379: SSL_connect failed: certificate verify failed
```

The client does not trust the server's certificate: wrong or missing `--cacert`, an expired or self-signed certificate. The server log says `tlsv1 alert unknown ca`. For the reason, run `openssl s_client -connect HOST:PORT -CAfile ca.crt` and read **Verify return code**, such as `10 (certificate has expired)`.

```text
Error: Server closed the connection
```

The TLS server wants a client certificate and got none, so the handshake ended. The server log says `peer did not return a certificate`. Pass `--cert` and `--key`, or check that the certificate is signed by the `tls-ca-cert-file` CA.

```text
Error: Connection reset by peer
```

A plain client talked to a TLS port. The server log says `Error accepting a client connection: error:0A00010B:SSL routines::wrong version number`. Add `--tls`. The reverse mistake, `--tls` on a plain port, hangs with no output: run it as `timeout 5 redis-cli --tls ...`.

```sh
redis-cli --tls --cacert /etc/redis/tls/ca.crt --cert /etc/redis/tls/client.crt --key /etc/redis/tls/client.key CONFIG GET 'tls-*'
```

The TLS settings the server runs with. Set `tls-port`, `tls-cert-file`, `tls-key-file` and `tls-ca-cert-file` in the config; files, ciphers and protocols show here, and the `tls-cluster` and `tls-replication` switches. Both of those stay `no` unless you set them. A replica that cannot reach a TLS primary usually lacks `tls-replication yes`. If the key has a passphrase, `tls-key-file-pass` and `tls-client-key-file-pass` print here in clear: remove them before you paste the output anywhere.

### Redis errors

```text
OOM command not allowed when used memory > 'maxmemory'.
```

Full, with `maxmemory-policy` noeviction. A cache wants allkeys-lru; a datastore needs more memory. Reads still work. Client buffers count toward the limit, replica buffers do not (they still use RAM), so check `MEMORY STATS`, and `INFO errorstats` shows `errorstat_OOM`.

```text
LOADING Redis is loading the dataset in memory
```

It has restarted and is reading its dump, or a replica is loading a snapshot from its primary. Wait. `INFO persistence` shows `loading:1` and `loading_eta_seconds`. Health checks should wait for `loading:0`.

```text
READONLY You can't write against a read only replica.
```

You reached a replica. After a failover the client still points at the old primary; use a Sentinel- or Cluster-aware client. Check `ROLE` on the address the client uses.

```text
NOAUTH Authentication required.
```

No credentials sent. WRONGPASS: a wrong password, or an ACL user without access. A replica that lost its `masterauth` logs this against its primary.

```text
WRONGPASS invalid username-password pair or user is disabled.
```

The user or password is wrong, or the user is `off`. Look in `ACL LOG` for the entry with reason `auth` and the username. `redis-cli` shows it as `AUTH failed: WRONGPASS`.

```text
NOPERM User ro has no permissions to run the 'set' command
```

The user lacks a command, shown in lowercase, as `config|get` for a subcommand. `NOPERM No permissions to access a key` is a key pattern miss. Redis 7.0 words it "this user has no permissions to run the 'set' command" and "this user has no permissions to access one of the keys used as arguments". `ACL GETUSER` shows the rules and `ACL LOG` the exact refusal.

```text
NOREPLICAS Not enough good replicas to write.
```

`min-replicas-to-write` is set and too few replicas are online, or all lag more than `min-replicas-max-lag` seconds. Check `INFO replication` on the primary: `connected_slaves` and each lag.

```text
ERR max number of clients reached
```

`maxclients` is full. `rejected_connections` counts these. Find who holds the connections with `CLIENT LIST`, fix the leak, and check `ulimit -n` before raising `maxclients`.

## MongoDB

Most trouble is a missing index, a slow election, replication lag or a full cache. The commands run in `mongosh`; they were tested on MongoDB 7.0 and 8.0, and `db.` means the current database.

### Connect

```sh
mongosh "mongodb://HOST:27017/DB" -u DBUSER --authenticationDatabase admin
```

With a user and no password, `mongosh` asks for it without echo. Never use `-p PASSWORD`: it shows in `ps` and `/proc` for every user. A password inside the URI is as visible; `mongodb://DBUSER@HOST/DB` also prompts.

```js
db.hello()
```

**isWritablePrimary** and **secondary** say what this node is. **primary** names the primary, **hosts** the members, **setName** the replica set, **maxBsonObjectSize** the document limit (16777216 bytes, 16 MiB). On a standalone, setName, primary, hosts and secondary are missing. `isMaster` is the old name.

```sh
mongosh --quiet --eval 'db.adminCommand({listDatabases:1}).databases.map(d=>[d.name,d.sizeOnDisk])' "mongodb://HOST:27017"
```

Size on disk per database, in bytes. Compare with `df -h` on the data path. `local` holds the oplog and can be large on a replica set member.

```sh
mongostat --host HOST --rowcount 5
```

One line per second: operations per type, **dirty** and **used** (the cache fill, in percent), **qrw** and **arw** (queued and active readers and writers), **conn**, **net_in** and **net_out**, and **repl** (`PRI`, `SEC`, `ARB`, or `RTR` for mongos). A `*` before a count marks an operation replicated from the primary.

### Server status

```js
db.serverStatus().connections
```

**current** against **available**: when available hits 0 new clients are refused, and the log says `Connection refused because there are too many open connections`. **rejected** counts the refusals. **active** is the connections running an operation now. The limit is `net.maxIncomingConnections`.

```js
db.serverStatus().opcounters
```

Counters since start: insert, query, update, delete, getmore, command. They only grow, so sample twice and subtract for a rate. Sudden `query` growth with high CPU is usually a missing index or a retry storm.

```js
const c=db.serverStatus().wiredTiger.cache; ["maximum bytes configured","bytes currently in the cache","tracked dirty bytes in the cache","application thread time evicting (usecs)","pages read into cache"].forEach(k=>print(k, c[k]))
```

The WiredTiger cache, in bytes. The cache fills toward the maximum, and that is normal. When it nears full or the dirty part passes about 20 percent, application threads evict pages and queries slow: watch the evicting time grow. Add RAM or reduce the working set.

```js
db.serverStatus().wiredTiger.concurrentTransactions
db.serverStatus().queues.execution
```

Read and write tickets. On 7.0 `concurrentTransactions` has **out**, **available** and **totalTickets**; on 8.0 it is gone and `queues.execution` has the same fields. **available** at 0 with **out** equal to **totalTickets** means every slot is busy and new operations queue.

```js
db.serverStatus().globalLock.currentQueue
```

**readers** and **writers** are operations waiting for a lock. A queue that stays above 0 means slow operations hold things up. Find them with `db.currentOp()`; do not treat adding connections as the fix.

```js
db.serverStatus().asserts
```

Server-side assertion counters. **regular** or **warning** rising means errors in the server log worth reading. **user** counts client errors, such as duplicate keys, and is usually noise.

### Operations in flight

```js
db.currentOp({active:true, secs_running:{$gt:5}})
```

Operations running over 5 seconds. **opid** is what you kill; **op** and **ns** say what and where; **planSummary** `COLLSCAN` is a full collection scan; **client** and **desc** name the connection; **waitingForLock** `true` means it waits on another operation. Look at **command** for the query.

```js changes
db.killOp(ID)
```

Asks the server to stop operation **opid** (use the number from `currentOp`). The client gets `Interrupted` (code 11601). Do not kill replication, oplog or index-build operations on a secondary, or a chunk migration.

```js
db.getSiblingDB("admin").aggregate([{$currentOp:{allUsers:true,idleConnections:false}},{$match:{secs_running:{$gt:1}}}])
```

The same data as an aggregation, so you can filter and sort. With `allUsers:true` and the right role it shows operations of every user. On a sharded cluster, run it through `mongos` to see all shards.

```text
MongoServerError: Executor error during find command: app.c :: caused by :: operation exceeded time limit
```

The operation ran past its `maxTimeMS`, code 50 `MaxTimeMSExpired`. Code 262 `ExceededTimeLimit` is the same condition raised elsewhere. Add an index, or raise `maxTimeMS` on purpose. The server stopped the work, so nothing is left running.

```text
MongoServerError: Executor error during find command: app.c :: caused by :: operation was interrupted
```

Code 11601 `Interrupted`: someone ran `killOp`. The same text with code 11602 `InterruptedDueToReplStateChange` is a stepdown or election, and with 11600 `InterruptedAtShutdown` a shutdown. If you did not kill it, look for a primary election at that time.

### Replica set

```js
rs.status().members.map(m=>[m.name,m.stateStr,m.health,m.syncSourceHost,m.lastHeartbeatMessage])
```

Name, state, health (1 up, 0 down), where each secondary copies from, and the last heartbeat error. States: `PRIMARY`, `SECONDARY`, `STARTUP2` (initial sync), `RECOVERING`, `ROLLBACK`, `ARBITER`, `(not reachable/healthy)`. Exactly one PRIMARY is normal.

```text
Timed out connecting to m3:27017 after 20000ms
```

A **lastHeartbeatMessage** for a member that is up but silent: a firewall drop, a stopped (frozen) process or a paused container. Test the route and port from the other members. The member shows `(not reachable/healthy)` meanwhile.

```text
Error connecting to m2:27017 :: caused by :: Could not find address for m2:27017: SocketException: onInvoke :: caused by :: Host not found (authoritative)
```

A **lastHeartbeatMessage** for a member whose name does not resolve. Check DNS or `/etc/hosts` on every member, using the name in the replica set config. The log line is `Heartbeat failed after max retries` with code 6 `HostUnreachable`.

```js
rs.printSecondaryReplicationInfo()
```

One block per secondary: **syncedTo** and **replLag**, how far behind the primary it is. A lag that grows means it cannot keep up: slow disk, network, a long index build, or a burst of writes. A member in a failed state says `no replication info`.

```js
rs.printReplicationInfo()
```

The oplog: **configured oplog size**, **log length start to end** (the oplog window) and the first and last event times. The window is how long a secondary can be away and still catch up. Keep it above your longest outage, initial sync or backup.

```js changes
db.adminCommand({replSetResizeOplog:1, size:16384})
```

Sets the oplog size in MB, with no restart. Run it on each member. Growing it widens the window. A big window needs disk, and shrinking can drop old entries.

```js
db.serverStatus().electionMetrics
```

How often elections happened and why: **stepUpCmd**, **priorityTakeover**, **electionTimeout**, **catchUpTakeover**. A rising **electionTimeout** means members lost contact with the primary. Also `rs.status().term` rises by one per election.

```sh
grep -E '"c":"ELECTION"' /var/log/mongodb/mongod.log | tail -5
```

Election lines in the structured log: `Starting an election, since we've seen no PRIMARY in election timeout period` (the timeout is 10 seconds), `Dry election run succeeded` and `Election succeeded, assuming primary role`. The path is the package default; `systemLog.path` sets it, and in containers the log goes to stdout.

```js changes
rs.stepDown(60)
```

The primary steps down and will not run for 60 seconds, so another member takes over. Clients see `not primary` for a few seconds. It waits for a secondary to catch up first. Use it before maintenance on the primary.

```text
MongoServerError: not primary
```

Code 10107 `NotWritablePrimary` (older servers: `not master`). The write went to a secondary, or a primary that has stepped down. Connect with the replica set URI (`replicaSet=REPLSET`) and `retryWrites=true`, not to one host with `directConnection=true`.

```text
MongoWriteConcernError: waiting for replication timed out
```

Code 64 `WriteConcernFailed`: the write used `w: 3` or `majority` and a member did not acknowledge within `wtimeout`. The timeout does not undo the write on the primary, but until a majority has it, a failover can roll it back. Check `rs.status()` for a down member.

```text
MongoServerSelectionError: Server selection timed out after 3000 ms
```

The driver found no suitable server: no primary during an election, a wrong `replicaSet` name, or the members unreachable. Its `serverSelectionTimeoutMS` was 3000. Check `rs.status()`, DNS, the firewall and the replica set name in the URI.

```text
MongoNetworkTimeoutError: connection 3 to 172.22.0.2:27017 timed out
```

The driver gave up waiting for a reply after `socketTimeoutMS`. The server may still be running the operation: check `currentOp` and add `maxTimeMS`, so the server stops too. A refused connection says `ECONNREFUSED`; a bad name says `getaddrinfo ENOTFOUND`.

### Slow queries and indexes

```js changes
db.setProfilingLevel(1, {slowms: 100})
db.getProfilingStatus()
```

Level 1 records operations slower than 100 ms in `system.profile` of the current database; level 2 records everything and costs more. This `slowms` also sets the threshold for the slow query log of the whole server. Set the level back to 0 when done.

```js
db.system.profile.find().sort({ts:-1}).limit(5)
```

The latest slow operations. **millis** is the time, **ns** the collection, **planSummary** the plan (`COLLSCAN` or `IXSCAN { ... }`), **keysExamined** and **docsExamined** the work and **nreturned** the result. Examined far above returned means a missing or wrong index.

```text
{"t":{"$date":"2026-11-20T16:33:58.931+00:00"},"s":"I","c":"COMMAND","msg":"Slow query","attr":{"type":"command","ns":"app.c","durationMillis":34,"planSummary":"COLLSCAN","keysExamined":0,"docsExamined":60000,"nreturned":101}}
```

A slow query line in the log, shortened. Operations over `slowms` (100 ms by default; this sample ran with `slowms` lowered) are logged without the profiler. **planSummary** `COLLSCAN` with large **docsExamined** is a full scan.

```sh
jq -c 'select(.msg=="Slow query")|[.attr.ns,.attr.durationMillis,.attr.planSummary,.attr.docsExamined,.attr.nreturned]' /var/log/mongodb/mongod.log | tail
```

The latest slow queries as short rows: collection, milliseconds, plan, documents examined and returned. Without `jq`, use `grep '"Slow query"'`. Repeated shapes with `COLLSCAN` are the ones to index first.

```js
db.COLLECTION.find({g: 5}).explain("executionStats")
```

**winningPlan** `COLLSCAN` reads every document; `IXSCAN` uses an index. Compare **totalDocsExamined** with **nReturned**: 60000 against 600 is a scan for 1 percent of the data. **executionTimeMillis** and **totalKeysExamined** show the cost. This runs the query, so a `COLLSCAN` loads the server.

```js changes
db.COLLECTION.createIndex({g: 1, i: -1})
```

Builds an index; equality fields first, then sort fields. It builds while the collection stays usable, but costs IO and CPU on every member, so run it off-peak. The same query then reads 600 documents and 600 keys, not 60000.

```js
db.COLLECTION.getIndexes()
db.COLLECTION.aggregate([{$indexStats:{}}])
```

The indexes and how often each was used since the last restart: **accesses.ops** of 0 on a long-running server is an unused index. Unused indexes cost write speed and cache. Do not drop one right after a restart. The counts are per member: check every member, secondaries included, before calling an index unused.

```js changes
db.COLLECTION.hideIndex("INDEXNAME")
```

Hides an index from the planner but keeps it up to date, so you can test if a drop is safe. `unhideIndex` brings it back at once. Watch the slow query log for a day before `dropIndex`.

```js
const s=db.COLLECTION.stats(); [s.count, s.avgObjSize, s.size, s.storageSize, s.totalIndexSize]
```

Document count, average size, data size, size on disk and index size, in bytes. Index size should fit in the cache. A big **storageSize** against **size** means space freed by deletes that the OS has not got back.

### Disk and compaction

```js
db.stats()
```

**dataSize**, **storageSize**, **indexSize** and **totalSize**, and **fsUsedSize** with **fsTotalSize** for the disk holding the data. `fsUsedSize` over 85 percent of `fsTotalSize` needs action now: MongoDB can stop on a full disk.

```sh
df -h DATADIR && du -sh DATADIR/* | sort -h | tail
```

The filesystem and the biggest entries, largest last. In the data path, `collection-*.wt` and `index-*.wt` are one per collection and index. Also look at `diagnostic.data`, journal and the log folder. Delete no data file by hand.

```js
db.COLLECTION.aggregate([{$collStats:{storageStats:{}}}]).toArray()[0].storageStats.freeStorageSize
```

Bytes inside the collection file that deletes freed and MongoDB will reuse. The OS does not get them back. A large value after mass deletes is normal. If you need the disk space, compact or resync that member.

```js changes
db.runCommand({compact: "COLLECTION"})
```

Rewrites the collection file and gives free space back to the OS; the answer has **bytesFreed**. Run it on a secondary first, off-peak, then step down the primary and do the same. It can block operations on that collection; check the docs for your version.

### Sharding

```js
sh.status()
```

Run the sharding commands on a `mongos`. Shards, the active mongoses, **autosplit**, the **balancer** (enabled, running, failed rounds, migrations in 24 hours) and each sharded collection with its shard key and chunks. The balancer evens data size per shard, not chunk count, so chunk counts can differ; compare data per shard with getShardDistribution().

```js
db.adminCommand({balancerStatus: 1})
sh.getBalancerState()
```

**mode** `full` means the balancer is on; `off` means stopped. **inBalancerRound** says it is moving chunks now. Moves cost IO on two shards, so a balancer that never rests at peak hours is a reason to set a balancer window.

```js changes
sh.stopBalancer()
```

Stops the balancer, for a backup or upgrade. A migration in progress finishes first. Do not forget to start it again: the shards drift apart while it is off.

```js changes
sh.startBalancer()
```

Starts the balancer again after a backup or upgrade. `sh.getBalancerState()` says which state it is in.

```js
db.getSiblingDB("config").chunks.find({jumbo: true})
```

Jumbo chunks: too large to split and so never moved. An empty result is healthy. A jumbo chunk comes from one shard key value with too much data. The fix is a better key (`refineCollectionShardKey`, or `reshardCollection` on 5.0 and later), not the balancer.

```js
db.COLLECTION.getShardDistribution()
```

Data, documents and chunks per shard, with the share of each. A shard far above the others is where the load and the disk go. Run it on the sharded collection through `mongos`.

### Backups

```sh changes
mongodump --uri "mongodb://DBUSER@HOST:27017/?authSource=admin&replicaSet=REPLSET&readPreference=secondary" --oplog --gzip --archive=FILE
```

A consistent dump of the whole replica set from a secondary; `--oplog` adds the writes made while it ran. With a user and no password it prompts, so nothing is on the command line. `FILE` is overwritten and every document is read. `--oplog` fails with `--db`: `bad option: --oplog mode only supported on full dumps`.

```sh danger
mongorestore --uri "mongodb://DBUSER@HOST:27017/?authSource=admin" --gzip --archive=FILE --oplogReplay
```

Restores the archive and replays the oplog, for a point in time consistent with the end of the dump. Documents that already exist fail as duplicates; add `--drop` only if you mean to replace collections. It prints `document(s) restored successfully`; count the documents after. Restore into an empty or scratch deployment; replaying the oplog over live data can revert or delete newer documents.

### MongoDB errors

```text
MongoServerError: E11000 duplicate key error collection: app.e index: u_1 dup key: { u: "a" }
```

Code 11000: a unique index, here `u_1`, or `_id_`, already holds that value. The message gives the collection, the index and the value. Look for a retry that repeated an insert, or use an upsert or `updateOne`.

```text
MongoServerError: Caused by :: Write conflict during plan execution and yielding is disabled. :: Please retry your operation or multi-document transaction.
```

Code 112 `WriteConflict`, with the label `TransientTransactionError`: two transactions changed the same document. Retry the transaction. If it is frequent, a hot document is the cause: shorten transactions or split the counter.

```text
MongoServerError: PlanExecutor error during aggregation :: caused by :: BSONObj size: 50331394 (0x2FFFF02) is invalid. Size must be between 0 and 16793600(16MB) First element: _id: ObjectId('...')
```

Code 10334 `BSONObjectTooLarge`: a document, here one built by a pipeline stage, passed the 16 MB limit. Fix the data shape: store large arrays as separate documents or use GridFS. Clients refuse to send an oversized insert; `mongosh` shows a `RangeError` for it.

```text
MongoServerError: Command find requires authentication
```

Code 13 `Unauthorized`: the connection never logged in and `--auth` is on. Add the user and `authSource` to the URI. With `not authorized on app to execute command { insert: ... }` the login worked but the role lacks that action; check `db.runCommand({connectionStatus:1})`.

```text
MongoServerError: Authentication failed.
```

Code 18 `AuthenticationFailed`: a wrong user, password or `authSource`. The user is looked up in the database named by `authSource`, which is often `admin`, not the one you query. The server log shows the reason and the mechanism.

```text
MongoServerSelectionError: connection <monitor> to 127.0.0.1:27017 closed
```

The server accepted and closed the connection: it is at its connection limit, or it is shutting down. The log has `Connection refused because there are too many open connections`. Compare `db.serverStatus().connections` with `net.maxIncomingConnections`, and find the leak.

## Elasticsearch and OpenSearch

The cluster turns yellow or red when shards cannot be placed, and red is real data unavailable. Disks, heap and thread pools cause most of it. Examples target Elasticsearch 8 with security on, so each curl uses `-sS --cacert CA --netrc-file ~/.es.netrc` over HTTPS; with security off, as on a dev box or ES 7, use `http://` and drop those flags. OpenSearch 2.x uses the same API; its differences are in the last group.

### Elasticsearch and OpenSearch: connecting safely

```sh changes
(umask 077; read -rsp 'Password: ' PW; printf 'machine HOST\nlogin elastic\npassword %s\n' "$PW" > ~/.es.netrc; unset PW)
```

Never put a password in `-u user:pass`: it shows in `ps` and in shell history. This prompts for it and writes `~/.es.netrc` readable by you only. `machine` must match the host name in the URL. `printf` is a shell builtin, so the password never appears in a process list. Use `login admin` for an OpenSearch demo install. Run it in bash: `read -rsp` fails on dash. An existing `~/.es.netrc` is replaced. Delete the file when finished.

```sh
curl -sS --cacert /etc/elasticsearch/certs/http_ca.crt --netrc-file ~/.es.netrc 'https://HOST:9200/'
```

The banner: **cluster_name**, **version.number** and, on OpenSearch, `"distribution": "opensearch"`. `--cacert` takes your cluster's CA (the package install puts `http_ca.crt` there; a Docker image keeps it under `config/certs`). Never use `-k` to skip the check.

```sh
curl -sS -u elastic --cacert /etc/elasticsearch/certs/http_ca.crt 'https://HOST:9200/_cluster/health?pretty'
```

`-u elastic` with no colon makes curl prompt for the password, so nothing is stored or visible. Use it for a one-off check. The cluster health, explained next.

### Elasticsearch and OpenSearch: cluster health and shards

```sh
curl -sS --cacert /etc/elasticsearch/certs/http_ca.crt --netrc-file ~/.es.netrc 'https://HOST:9200/_cluster/health?pretty'
```

**status**: green is every shard assigned; yellow is every primary assigned but some replica is not (reads and writes work, no redundancy); red is at least one primary unassigned, so that index's data is partly unavailable. Also read **unassigned_shards**, **number_of_pending_tasks** and **active_shards_percent_as_number**.

```sh
curl -sS --cacert /etc/elasticsearch/certs/http_ca.crt --netrc-file ~/.es.netrc 'https://HOST:9200/_cluster/health?level=indices&pretty'
```

Adds a status per index, so you see which index is red or yellow. For a long list use `_cat/indices?v&health=red` below.

```sh
curl -sS --cacert /etc/elasticsearch/certs/http_ca.crt --netrc-file ~/.es.netrc 'https://HOST:9200/_cluster/health?wait_for_status=green&timeout=30s&pretty'
```

Blocks up to 30 seconds for green. `"timed_out": true` means it did not get there and the reported status is the current one. Use it in a script after a rolling restart, never as a monitor.

```sh
curl -sS --cacert /etc/elasticsearch/certs/http_ca.crt --netrc-file ~/.es.netrc 'https://HOST:9200/_cat/nodes?v&h=name,ip,node.role,master,heap.percent,ram.percent,cpu,load_1m,disk.used_percent'
```

One row per node. **master** `*` marks the elected master. A **heap.percent** that stays above 85 is pressure, while a high **ram.percent** is normal (the OS cache). A node missing from the list has left the cluster. **node.role** letters: `m` master, `d` data, `i` ingest.

```sh
curl -sS --cacert /etc/elasticsearch/certs/http_ca.crt --netrc-file ~/.es.netrc 'https://HOST:9200/_cat/indices?v&health=red&s=index'
```

Lists only the red indices. Change `red` to `yellow` for the replica gaps. A red index with no documents or sizes has no active shard copy at all right now.

```sh
curl -sS --cacert /etc/elasticsearch/certs/http_ca.crt --netrc-file ~/.es.netrc 'https://HOST:9200/_cat/shards?h=index,shard,prirep,state,unassigned.reason&s=state' | grep UNASSIGNED
```

Every unassigned shard and why, such as `INDEX_CREATED` (a replica with nowhere to go on a single node), `NODE_LEFT`, `ALLOCATION_FAILED` or `CLUSTER_RECOVERED`. **prirep** `p` is a primary and `r` a replica. A `p` row here is the red one. The full shard list is large on big clusters.

```sh
curl -sS --cacert /etc/elasticsearch/certs/http_ca.crt --netrc-file ~/.es.netrc 'https://HOST:9200/_cluster/allocation/explain?pretty'
```

Explains one unassigned shard (it chooses; the **note** says so). Read **can_allocate**, **allocate_explanation**, then **node_allocation_decisions**, where each **decider** says why a node refused: `same_shard` (a copy is already there), `disk_threshold`, `filter`, `awareness`, `max_retry`. 400 means there is nothing unassigned.

```sh
curl -sS --cacert /etc/elasticsearch/certs/http_ca.crt --netrc-file ~/.es.netrc -X POST 'https://HOST:9200/_cluster/allocation/explain?pretty' -H 'content-type: application/json' -d '{"index":"INDEXNAME","shard":0,"primary":true}'
```

The same for the shard you name. Set `"primary": false` for a replica. For a started shard it explains why it stays where it is. A primary with **last_allocation_status** `no_valid_shard_copy` has no good copy on any node now in the cluster: bring back the node that held it before you consider anything else.

```sh
curl -sS --cacert /etc/elasticsearch/certs/http_ca.crt --netrc-file ~/.es.netrc 'https://HOST:9200/_cat/allocation?v'
```

Shards and disk per node: **disk.percent**, **disk.avail**, **shards**. The `UNASSIGNED` row counts shards with no home. Compare **disk.percent** with the watermarks below; a node near 85 percent stops receiving new shards.

```sh
curl -sS --cacert /etc/elasticsearch/certs/http_ca.crt --netrc-file ~/.es.netrc 'https://HOST:9200/_cat/recovery?v&active_only=true'
```

Shards recovering right now, with **stage** and **bytes_percent**. Empty is idle. A recovery stuck at one percentage or restarting means a network or disk problem between the nodes. Many at once means a node restart or a rebalance is under way.

```sh
curl -sS --cacert /etc/elasticsearch/certs/http_ca.crt --netrc-file ~/.es.netrc 'https://HOST:9200/_cluster/pending_tasks?pretty'
```

Cluster-state updates waiting for the master. `"tasks": [ ]` is healthy. A queue that grows, or entries with a long **time_in_queue_millis**, means an overloaded master: often tens of thousands of shards or very frequent mapping updates.

```sh changes
curl -sS --cacert /etc/elasticsearch/certs/http_ca.crt --netrc-file ~/.es.netrc -X POST 'https://HOST:9200/_cluster/reroute?retry_failed=true&filter_path=acknowledged'
```

Retries shards that failed allocation five times (`max_retry` in the explain output) and gave up. Fix the cause first, such as disk space or a missing node, then run this. It moves nothing that is already healthy.

```sh changes
curl -sS --cacert /etc/elasticsearch/certs/http_ca.crt --netrc-file ~/.es.netrc -X PUT 'https://HOST:9200/INDEXNAME/_settings' -H 'content-type: application/json' -d '{"index.number_of_replicas":0}'
```

Turns an index green on a single-node cluster by dropping its replicas, which cannot be placed beside the primary. On a multi-node production cluster this removes your redundancy: restore it once the data nodes are back.

### Elasticsearch and OpenSearch: disk watermarks and read-only indices

```sh
curl -sS --cacert /etc/elasticsearch/certs/http_ca.crt --netrc-file ~/.es.netrc 'https://HOST:9200/_cluster/settings?include_defaults=true&filter_path=*.cluster.routing.allocation.disk.watermark*&pretty'
```

The disk thresholds. Defaults: **low** 85 percent (no new shards on the node), **high** 90 percent (move shards away), **flood_stage** 95 percent (every index with a shard on the node becomes read-only). Elasticsearch 8 also has `max_headroom` caps for large disks. A value you set shows under `persistent` instead.

```text
index [logs] blocked by: [TOO_MANY_REQUESTS/12/disk usage exceeded flood-stage watermark, index has read-only-allow-delete block];
```

`cluster_block_exception`, HTTP 429. A node passed the flood stage, so its indices accept deletes but no writes. **Fix** by freeing disk (delete old indices, add a node). Once the node is under the high watermark the block lifts on its own; list indices still blocked with the next entry.

```sh
curl -sS --cacert /etc/elasticsearch/certs/http_ca.crt --netrc-file ~/.es.netrc 'https://HOST:9200/INDEXNAME/_settings?filter_path=**.blocks&pretty'
```

Shows `index.blocks.read_only_allow_delete: true` (or `write`, `read_only`) when an index is blocked. `{ }` means no block. Check this after freeing disk, because a block set by an old version or by hand does not lift by itself.

```sh changes
curl -sS --cacert /etc/elasticsearch/certs/http_ca.crt --netrc-file ~/.es.netrc -X PUT 'https://HOST:9200/INDEXNAME/_settings' -H 'content-type: application/json' -d '{"index.blocks.read_only_allow_delete":null}'
```

Removes the read-only block from one index, after you have freed disk; if the node is still above flood stage the block comes back. `_all` works on Elasticsearch, but OpenSearch's security plugin refused `_all` and `*` with `security_exception`, so name each index.

```sh changes
curl -sS --cacert /etc/elasticsearch/certs/http_ca.crt --netrc-file ~/.es.netrc -X PUT 'https://HOST:9200/_cluster/settings' -H 'content-type: application/json' -d '{"persistent":{"cluster.routing.allocation.disk.watermark.low":"88%","cluster.routing.allocation.disk.watermark.high":"92%","cluster.routing.allocation.disk.watermark.flood_stage":"96%"}}'
```

Buys time while you add disk: values must stay ordered low, high, flood. It leaves less free space, so treat it as a short loan. Put `null` in each value to restore the defaults.

```text
index [logs] blocked by: [FORBIDDEN/8/index write (api)];
```

A different `cluster_block_exception` (HTTP 403): someone set `index.blocks.write` on purpose, or a tool did (shrink, clone, force-merge setup). It is not the disk. Clear it with `PUT INDEXNAME/_settings` and `{"index.blocks.write": null}` when the job is done.

### Elasticsearch and OpenSearch: heap, breakers and thread pools

```sh
curl -sS --cacert /etc/elasticsearch/certs/http_ca.crt --netrc-file ~/.es.netrc 'https://HOST:9200/_nodes/stats/jvm,breaker?filter_path=nodes.*.jvm.mem.heap_used_percent,nodes.*.jvm.gc.collectors.*.collection_count,nodes.*.breakers.*.tripped&pretty'
```

**heap_used_percent** that stays above 85, and a rising old-generation **collection_count**, mean heap pressure. **tripped** is a count of circuit breaker trips since the node started: any growth means requests are being refused. Keep `-Xms` equal to `-Xmx` and under half of RAM.

```sh
curl -sS --cacert /etc/elasticsearch/certs/http_ca.crt --netrc-file ~/.es.netrc 'https://HOST:9200/_cat/thread_pool/write,search,get?v&h=node_name,name,active,queue,queue_size,rejected,completed'
```

Per node and pool. **rejected** is cumulative since startup, so look for growth between two runs. A **queue** near **queue_size** means requests arrive faster than they finish. Rejections on `write` are bulk indexing overload; on `search`, too many or too heavy searches.

```sh
curl -sS --cacert /etc/elasticsearch/certs/http_ca.crt --netrc-file ~/.es.netrc 'https://HOST:9200/_cat/thread_pool?v&h=node_name,name,active,queue,rejected&s=rejected:desc'
```

Every pool, sorted by rejections, so the busiest shows first. Useful when you do not know which pool is saturated: `write`, `search`, `snapshot`, `management` and `get` are the usual ones.

```sh
curl -sS --cacert /etc/elasticsearch/certs/http_ca.crt --netrc-file ~/.es.netrc 'https://HOST:9200/_nodes/hot_threads?threads=3'
```

The busiest threads on each node, sampled for 500 ms, with a stack. Look at the thread name (`search`, `write`, `merge`, `refresh`) and the percentage; a node that is idle prints almost nothing. Run it during the slowdown, not after.

```sh
curl -sS --cacert /etc/elasticsearch/certs/http_ca.crt --netrc-file ~/.es.netrc 'https://HOST:9200/_nodes/stats/fs?filter_path=nodes.*.fs.total&pretty'
```

Bytes **total_in_bytes**, **free_in_bytes** and **available_in_bytes** per node. Elasticsearch uses the **available** figure for watermarks. Use it when `_cat/allocation` and `df` disagree: reserved blocks make `available` smaller than `free`.

```sh
curl -sS --cacert /etc/elasticsearch/certs/http_ca.crt --netrc-file ~/.es.netrc 'https://HOST:9200/_tasks?detailed=true&actions=*search&pretty'
```

Searches running now, with the node, the running time and the request description. An empty list means none. A task with minutes of running time and a huge query is the one eating the search pool. Cancelling is possible through the task API once you know the id.

### Elasticsearch and OpenSearch: slow logs and snapshots

```sh changes
curl -sS --cacert /etc/elasticsearch/certs/http_ca.crt --netrc-file ~/.es.netrc -X PUT 'https://HOST:9200/INDEXNAME/_settings' -H 'content-type: application/json' -d '{"index.search.slowlog.threshold.query.warn":"2s","index.indexing.slowlog.threshold.index.warn":"2s"}'
```

Logs any query or indexing request slower than 2 seconds at WARN on the shard. Package installs write them to `/var/log/elasticsearch/*_index_search_slowlog.json`; a container sends them to stdout. Each line has the **took** time and the query or document source. Set `-1` to turn off.

```sh
curl -sS --cacert /etc/elasticsearch/certs/http_ca.crt --netrc-file ~/.es.netrc 'https://HOST:9200/_cat/repositories?v'
```

Registered snapshot repositories and their type. Empty means no snapshots are possible: with no repository you have no backup. An `fs` repository needs `path.repo` set on every node.

```sh changes
curl -sS --cacert /etc/elasticsearch/certs/http_ca.crt --netrc-file ~/.es.netrc -X POST 'https://HOST:9200/_snapshot/REPO/_verify?pretty'
```

Makes every node write a test file to the repository and lists the nodes that could. A node missing from the answer, or an error, means that node cannot reach the storage. It writes a tiny file, nothing else.

```sh
curl -sS --cacert /etc/elasticsearch/certs/http_ca.crt --netrc-file ~/.es.netrc 'https://HOST:9200/_cat/snapshots/REPO?v'
```

Snapshots in a repository with **status** (SUCCESS, PARTIAL, FAILED, IN_PROGRESS), **duration** and shard counts. Check the newest one: if the last SUCCESS is old, the backup job is failing. A PARTIAL has **failed_shards** above 0.

```sh changes
curl -sS --cacert /etc/elasticsearch/certs/http_ca.crt --netrc-file ~/.es.netrc -X PUT 'https://HOST:9200/_snapshot/REPO/SNAPNAME?wait_for_completion=false&pretty' -H 'content-type: application/json' -d '{"indices":"INDEXNAME"}'
```

Starts a snapshot of one index (default is every index plus cluster state) and returns at once. It reads shards and writes to the repository, so expect extra IO. Follow it with `_snapshot/_status`.

```sh
curl -sS --cacert /etc/elasticsearch/certs/http_ca.crt --netrc-file ~/.es.netrc 'https://HOST:9200/_snapshot/_status?pretty'
```

Snapshots running now with per-shard progress. `"snapshots": [ ]` means none. A stage stuck at `STARTED` for hours on one shard points to slow storage or a node problem.

```sh
curl -sS --cacert /etc/elasticsearch/certs/http_ca.crt --netrc-file ~/.es.netrc 'https://HOST:9200/_slm/policy?pretty'
```

Snapshot lifecycle policies (Elasticsearch): schedule, **last_success** and **last_failure**. `{ }` means no automatic snapshots. On OpenSearch the equivalent is `_plugins/_sm/policies`.

### Elasticsearch and OpenSearch errors

```text
circuit_breaking_exception: [request] Data too large, data for [preallocate[aggregations]] would be [6144/6kb], which is larger than the limit of [1/1b]
```

HTTP 429. A request would push a breaker past its limit; the name in brackets says which. `[parent]` is total heap use (95 percent by default) and `[fielddata]` is sorting or aggregating on text. **Fix** the query (smaller aggregation, `keyword` field, fewer buckets), then the heap size. Do not raise the breakers.

```text
es_rejected_execution_exception: rejected execution of TimedRunnable{original=org.elasticsearch.action.bulk.TransportAbstractBulkAction ...
```

HTTP 429. A thread pool queue was full. Here `write` rejected a bulk request. Clients should back off and retry; throttle indexing, send fewer concurrent bulks, or add data nodes. Raising `queue_size` only hides it. **Check** `_cat/thread_pool`.

```text
cluster_block_exception: blocked by: [SERVICE_UNAVAILABLE/2/no master];
```

The node sees no elected master, so the cluster cannot change state. **Check** that a majority of master-eligible nodes is up and can reach each other, and read each node's log for `master not discovered`. A single-node setup also needs `discovery.type: single-node`.

```text
search_phase_execution_exception: all shards failed
```

HTTP 400 or 503. Every shard failed the query; the useful part is **root_cause** and **failed_shards[].reason**. Seen with sorting on a text field (`Fielddata is disabled on [msg]`), with a bad query, and with a red index (`no_shard_available_action_exception`, HTTP 503). A 200 with `_shards.failed` above 0 is a partial result.

```text
unavailable_shards_exception: [stuck][0] primary shard is not active Timeout: [2s]
```

A write targets a primary that is not started, so the index is red. The same index fails searches with `no_shard_available_action_exception`. **Check** `_cluster/allocation/explain` for the primary and `_cat/shards` for the node that held it.

```text
document_parsing_exception: [1:6] failed to parse field [n] of type [integer] in document with id '...'. Preview of field's value: 'abc'
```

The document has a value the mapping cannot store (`caused_by` shows `number_format_exception`). Fix the producer or set `ignore_malformed` on the field. OpenSearch and older Elasticsearch releases report this as `mapper_parsing_exception`.

```text
mapper_parsing_exception: Failed to parse mapping: No handler for type [nosuchtype] declared on field [x]
```

The mapping itself is wrong: an unknown type, a bad parameter, or a field defined twice with different types. It is a create or update error, not a document one. Compare the failing mapping with `GET INDEXNAME/_mapping`; an existing field's type cannot change.

```text
document_parsing_exception: [1:24] failed to parse: Limit of total fields [3] has been exceeded while adding new fields [4]
```

The index hit `index.mapping.total_fields.limit` (1000 by default), usually from dynamic mapping of keys that vary, such as user ids as field names. Fix the data model (nested key and value fields, a flattened field) before raising the limit with `PUT INDEXNAME/_settings`.

```text
validation_exception: Validation Failed: 1: this action would add [1] shards, but this cluster currently has [6]/[1] maximum normal shards open;
```

The cluster is at `cluster.max_shards_per_node` times its data nodes (1000 by default). Delete or merge small indices, use fewer shards per index, or add data nodes. Raising the limit is a last resort: each shard costs heap.

```text
index_not_found_exception: no such index [nosuch]
```

HTTP 404. A typo, a deleted index, or a rolled-over name. Check `_cat/indices` and `_cat/aliases`; a write to a missing name creates it when `action.auto_create_index` allows.

```text
curl: (60) SSL certificate problem: self-signed certificate in certificate chain
```

curl does not trust the cluster's CA (OpenSSL 1.1 writes `self signed`). Pass `--cacert` with the CA file (Elasticsearch writes `http_ca.crt` at setup; OpenSearch demo uses `root-ca.pem` and says "unable to get local issuer certificate"). Do not use `-k`.

```text
security_exception: unable to authenticate user [elastic] for REST request [/]
```

HTTP 401: wrong password for that user. With no credentials sent the text is `missing authentication credentials for REST request [/]`. Test with `-u elastic` (it prompts) before you suspect the cluster. A user that authenticates but lacks the right gets 403 with `action [...] is unauthorized`.

### OpenSearch differences

```sh opensearch2+
curl -sS --cacert /usr/share/opensearch/config/root-ca.pem --netrc-file ~/.es.netrc 'https://HOST:9200/_cat/cluster_manager?v'
```

OpenSearch renamed the elected master to **cluster manager** (the demo Docker image logs in as `admin` and keeps its CA as `root-ca.pem` in the config folder). `_cat/nodes` shows both a **cluster_manager** and a **master** column. Health also reports `discovered_cluster_manager`.

```sh opensearch2+
curl -sS --cacert /usr/share/opensearch/config/root-ca.pem --netrc-file ~/.es.netrc 'https://HOST:9200/_plugins/_security/authinfo?pretty'
```

Who you are logged in as and your **roles**. A 401 or 403 on a call that worked before often means a changed role mapping: compare **backend_roles** with the mapping. `_plugins/_security/health` says whether the security plugin is `UP`.

```sh opensearch2.4+
curl -sS --cacert /usr/share/opensearch/config/root-ca.pem --netrc-file ~/.es.netrc 'https://HOST:9200/_nodes/stats/search_backpressure?pretty'
```

OpenSearch can cancel runaway searches itself, but only in `enforced` mode: the default `monitor_only` just counts, and the output's **mode** says which. This shows **cancellation_count** per resource tracker (CPU, heap, elapsed time). A rising count names the resource that is starving searches. It has no Elasticsearch counterpart.

```sh opensearch2+
curl -sS --cacert /usr/share/opensearch/config/root-ca.pem --netrc-file ~/.es.netrc 'https://HOST:9200/_plugins/_ism/explain/INDEXNAME?pretty'
```

Index State Management, OpenSearch's counterpart to ILM: the policy and state attached to an index. `null` for **policy_id** means the index is unmanaged. In Elasticsearch use `GET INDEXNAME/_ilm/explain`.

```sh opensearch2.1+
curl -sS --cacert /usr/share/opensearch/config/root-ca.pem --netrc-file ~/.es.netrc 'https://HOST:9200/_plugins/_sm/policies?pretty'
```

Snapshot management policies, the OpenSearch equivalent of `_slm/policy`. `"total_policies": 0` means no scheduled snapshots. The snapshot API itself (`_snapshot/REPO`) is identical.

```text
security_exception: no permissions for [] and User [name=admin, backend_roles=[admin], requestedTenant=null]
```

HTTP 403 from the security plugin. Seen when even the demo admin sent `_all/_settings` or `*/_settings`, which reach the protected security indices. Name the index explicitly. For other 403s the brackets name the missing action permission.
