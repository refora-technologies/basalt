# Basalt Host with no screen, packaged from a binary already built.
# @VERSION@ is filled in by packaging/build-server.sh, and the architecture
# by rpmbuild's --target: it packages a binary, so builds any on any machine.

%global debug_package %{nil}
%global __strip /bin/true
%global __os_install_post %{nil}

Name:           basalt-host-server
Version:        @VERSION@
Release:        1
Summary:        Basalt Host with no screen: shares a drive with your devices
License:        GPL-3.0-only
URL:            https://github.com/refora-technologies/basalt
Conflicts:      basalt-host
Recommends:     ffmpeg
Requires(pre):  shadow-utils
# For checking and downloading its updates over HTTPS.
Requires:       ca-certificates

%description
Basalt Host for a computer with no screen: a home server, a Raspberry Pi, a
NAS. It shares one drive or folder with your phones and computers on this
network, and is set up and managed from the Basalt app.

%install
mkdir -p %{buildroot}/usr/bin %{buildroot}/usr/lib/systemd/system \
    %{buildroot}/usr/lib/firewalld/services %{buildroot}/usr/share/doc/basalt-host-server
install -m 0755 %{_sourcedir}/basalt-host %{buildroot}/usr/bin/basalt-host
install -D -m 0755 %{_sourcedir}/basalt-host-update %{buildroot}/usr/lib/basalt-host/basalt-host-update
install -m 0644 %{_sourcedir}/basalt-host.service %{buildroot}/usr/lib/systemd/system/basalt-host.service
install -m 0644 %{_sourcedir}/basalt-host-update.service %{buildroot}/usr/lib/systemd/system/basalt-host-update.service
install -m 0644 %{_sourcedir}/basalt-host-update.path %{buildroot}/usr/lib/systemd/system/basalt-host-update.path
install -m 0644 %{_sourcedir}/basalt-host.firewalld.xml %{buildroot}/usr/lib/firewalld/services/basalt-host.xml
install -m 0644 %{_sourcedir}/README.md %{buildroot}/usr/share/doc/basalt-host-server/README.md

%files
/usr/bin/basalt-host
/usr/lib/basalt-host/basalt-host-update
/usr/lib/systemd/system/basalt-host.service
/usr/lib/systemd/system/basalt-host-update.service
/usr/lib/systemd/system/basalt-host-update.path
/usr/lib/firewalld/services/basalt-host.xml
/usr/share/doc/basalt-host-server/README.md

%pre
getent passwd basalt >/dev/null 2>&1 || \
    useradd --system --user-group --no-create-home --home-dir /var/lib/basalt-host \
        --shell /sbin/nologin --comment "Basalt Host" basalt
exit 0

%post
if [ -d /run/systemd/system ]; then
    systemctl daemon-reload >/dev/null 2>&1 || :
    if [ $1 -eq 1 ]; then
        systemctl enable --now basalt-host.service >/dev/null 2>&1 || :
        systemctl enable --now basalt-host-update.path >/dev/null 2>&1 || :
    else
        systemctl try-restart basalt-host.service >/dev/null 2>&1 || :
    fi
    # Whether it runs, where devices find it, the setup code, what is left.
    basalt-host --config /var/lib/basalt-host/host.json status --wait || :
fi

%preun
if [ $1 -eq 0 ] && [ -d /run/systemd/system ]; then
    systemctl disable --now basalt-host.service >/dev/null 2>&1 || :
    systemctl disable --now basalt-host-update.path >/dev/null 2>&1 || :
fi

%postun
if [ -d /run/systemd/system ]; then
    systemctl daemon-reload >/dev/null 2>&1 || :
fi
