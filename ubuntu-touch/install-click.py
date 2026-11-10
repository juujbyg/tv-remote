#!/usr/bin/env python3
"""Install a .click on Ubuntu Touch 24.04 through the system click service (the one the OpenStore
uses), so no sudo password is needed. Usage: install-click.py FILE.click"""
import json
import subprocess
import sys
import time

from gi.repository import Gio, GLib

path = sys.argv[1]
info = json.loads(subprocess.check_output(['click', 'info', path]))
name, version = info['name'], info['version']

bus = Gio.bus_get_sync(Gio.BusType.SYSTEM)
bus.call_sync('com.lomiri.click', '/com/lomiri/click', 'com.lomiri.click', 'Install',
              GLib.Variant('(s)', (path,)), None, 0, 300000, None)

# The service may return before the package is registered; wait for it to show up.
for _ in range(120):
    listed = dict(line.split('\t') for line in subprocess.check_output(['click', 'list'], text=True).splitlines() if '\t' in line)
    if listed.get(name) == version:
        print(f'Installed {name} {version}')
        sys.exit(0)
    time.sleep(1)
print(f'{name} {version} did not appear in `click list`; check `journalctl --user -n 50`')
sys.exit(1)
