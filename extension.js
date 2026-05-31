import GObject from 'gi://GObject';
import St from 'gi://St';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const ICON_ON = 'network-vpn-symbolic';
const ICON_OFF = 'network-vpn-disconnected-symbolic';

// Run a command asynchronously and return {ok, exitCode, stdout, stderr}.
function runCommand(argv) {
    return new Promise((resolve) => {
        let proc;
        try {
            proc = Gio.Subprocess.new(
                argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
        } catch (e) {
            resolve({ok: false, exitCode: -1, stdout: '', stderr: String(e)});
            return;
        }
        proc.communicate_utf8_async(null, null, (p, res) => {
            try {
                const [, stdout, stderr] = p.communicate_utf8_finish(res);
                const exitCode = p.get_exit_status();
                resolve({ok: exitCode === 0, exitCode, stdout: stdout ?? '', stderr: stderr ?? ''});
            } catch (e) {
                resolve({ok: false, exitCode: -1, stdout: '', stderr: String(e)});
            }
        });
    });
}

// Classify why a `tailscale` invocation failed, from its output.
function failureKind(res) {
    const msg = `${res.stderr} ${res.stdout}`.toLowerCase();
    if (msg.includes('failed to connect to local tailscaled') ||
        msg.includes("doesn't appear to be running") ||
        msg.includes('is tailscaled running'))
        return 'daemon-down';
    if (msg.includes('access denied') || msg.includes('permission') ||
        msg.includes('operator') || msg.includes("use 'sudo") ||
        msg.includes('must be run as root'))
        return 'no-access';
    if (msg.includes('needs login') || msg.includes('logged out') ||
        msg.includes('not logged in'))
        return 'needs-login';
    return null;
}

// Status label + actionable fix hint for each problem kind.
const PROBLEM_INFO = {
    'daemon-down': {
        status: 'Daemon not running',
        hint: 'The tailscaled daemon is stopped — start it to connect.',
    },
    'no-access': {
        status: 'Permission denied',
        hint: 'Run once:  sudo tailscale set --operator=$USER',
    },
    'needs-login': {
        status: 'Not logged in',
        hint: 'Run:  tailscale login',
    },
};

const TailscaleButton = GObject.registerClass({
    Signals: {'request-refresh': {}},
},
class TailscaleButton extends PanelMenu.Button {
    _init() {
        super._init(0.5, 'Tailscale', false);

        this._icon = new St.Icon({
            icon_name: ICON_OFF,
            style_class: 'system-status-icon',
        });
        this.add_child(this._icon);

        // Status line (non-interactive).
        this._statusItem = new PopupMenu.PopupMenuItem('Tailscale', {
            reactive: false,
            can_focus: false,
        });
        this._statusItem.label.add_style_class_name('ts-status-label');
        this.menu.addMenuItem(this._statusItem);

        // Connect / disconnect switch.
        this._switch = new PopupMenu.PopupSwitchMenuItem('Connect', false);
        this._switchId = this._switch.connect('toggled', (_item, state) => {
            // Ignore programmatic state changes from update(); only act on a
            // real user toggle.
            if (this._syncing)
                return;
            this._onToggled(state);
        });
        this.menu.addMenuItem(this._switch);

        // Actionable fix hint, shown when something needs setting up
        // (daemon down, no operator, logged out, or to stop the daemon).
        this._hintItem = new PopupMenu.PopupMenuItem('', {
            reactive: false,
            can_focus: false,
        });
        this._hintItem.label.add_style_class_name('ts-hint-label');
        this._hintItem.label.clutter_text.line_wrap = true;
        this._hintItem.visible = false;
        this.menu.addMenuItem(this._hintItem);

        // Contextual daemon action shown next to the hint. A plain button (not a
        // switch) so it only ever fires on a real click — never on a state sync.
        // Starting/stopping tailscaled needs root, so this is one pkexec prompt.
        this._daemonButton = new PopupMenu.PopupMenuItem('Start daemon');
        this._daemonButton.label.add_style_class_name('ts-action-label');
        this._daemonButton.connect('activate', () => this._onDaemonAction());
        this._daemonButton.visible = false;
        this.menu.addMenuItem(this._daemonButton);

        this._separator = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(this._separator);

        // Devices.
        this._devicesSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._devicesSection);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this.menu.addAction('Open Admin Console', () => {
            Gio.AppInfo.launch_default_for_uri(
                'https://login.tailscale.com/admin/machines', null);
        });

        // Refresh immediately whenever the menu is opened, so the device list
        // and status are always current when actually looked at.
        this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen)
                this.emit('request-refresh');
        });

        this._busy = false;
        this._syncing = false;
        this._daemonShouldStart = false;
    }

    async _onToggled(wantUp) {
        if (this._busy)
            return;
        this._busy = true;
        this._switch.setSensitive(false);

        // Assumes tailscaled is running and the user is the Tailscale operator
        // (see README setup) — so up/down need no privilege escalation.
        const res = await runCommand(['tailscale', wantUp ? 'up' : 'down']);

        this._switch.setSensitive(true);
        this._busy = false;

        if (!res.ok) {
            const info = PROBLEM_INFO[failureKind(res)];
            const message = info
                ? `${info.status}.\n${info.hint}`
                : (res.stderr || res.stdout || 'Command failed').trim();
            Main.notifyError('Tailscale', message);
        }
        // Reconcile the switch with reality (e.g. revert it if the command failed).
        this.emit('request-refresh');
    }

    async _onDaemonAction() {
        if (this._busy)
            return;
        this._busy = true;
        this._daemonButton.setSensitive(false);

        // Starting/stopping the systemd service requires root → one pkexec prompt.
        const action = this._daemonShouldStart ? 'start' : 'stop';
        const res = await runCommand(['pkexec', 'systemctl', action, 'tailscaled']);

        this._daemonButton.setSensitive(true);
        this._busy = false;

        if (!res.ok) {
            Main.notifyError('Tailscale',
                (res.stderr || res.stdout || 'Command failed').trim());
        }
        this.emit('request-refresh');
    }

    // Update icon, status text, switch and device list from status JSON.
    update(status) {
        const state = status?.BackendState ?? 'NoState';
        const running = state === 'Running';

        this._icon.icon_name = running ? ICON_ON : ICON_OFF;
        this._icon.opacity = running ? 255 : 90;

        const self = status?.Self ?? {};
        const selfIp = (self.TailscaleIPs && self.TailscaleIPs[0]) || '';

        // A problem is either a synthetic state from a failed status read, or a
        // real backend state that needs user action.
        const problem = state === 'Problem' ? status._problem
            : state === 'NeedsLogin' ? 'needs-login'
            : state === 'NoState' ? 'daemon-down'
            : null;

        // A real backend state (anything but our synthetic 'Problem') means the
        // daemon responded, i.e. it's running.
        const daemonRunning = state !== 'Problem';
        const daemonDown = problem === 'daemon-down';

        let statusText;
        let hint = null;
        if (running) {
            statusText = `Connected${selfIp ? `  ·  ${selfIp}` : ''}`;
        } else if (state === 'Stopped') {
            statusText = 'Disconnected';
            hint = 'Tailscale is disconnected but the daemon is still running.';
        } else if (problem && PROBLEM_INFO[problem]) {
            statusText = PROBLEM_INFO[problem].status;
            hint = PROBLEM_INFO[problem].hint;
        } else {
            statusText = state;
        }

        this._statusItem.label.text = statusText;
        this._hintItem.label.text = hint ?? '';
        this._hintItem.visible = !!hint;
        this._switch.label.text = running ? 'Connected' : 'Connect';

        // The connection toggle only works when the daemon is up. The daemon
        // button appears next to the hint while disconnected, so you can start it
        // (when down) or stop it (when up, to fully shut Tailscale down).
        const operable = running || state === 'Stopped';
        const showDaemon = !running && (daemonRunning || daemonDown);
        this._daemonShouldStart = daemonDown;
        this._daemonButton.label.text = daemonDown ? 'Start daemon' : 'Stop daemon';
        this._daemonButton.visible = showDaemon;
        if (!this._busy) {
            // Guard against setToggleState emitting "toggled" (it does on some
            // GNOME builds) so a state sync can't trigger a connect/disconnect.
            this._syncing = true;
            this._switch.setToggleState(running);
            this._syncing = false;
            this._switch.setSensitive(operable);
        }

        this._rebuildDevices(status, running);
    }

    _rebuildDevices(status, running) {
        this._devicesSection.removeAll();
        this._separator.visible = running;

        if (!running)
            return;

        const peers = status?.Peer ? Object.values(status.Peer) : [];
        peers.sort((a, b) => {
            const onlineDiff = (b.Online ? 1 : 0) - (a.Online ? 1 : 0);
            if (onlineDiff !== 0)
                return onlineDiff;
            return (a.HostName || '').localeCompare(b.HostName || '');
        });

        const self = status?.Self;
        if (self)
            this._addDeviceItem(self, true);

        for (const peer of peers)
            this._addDeviceItem(peer, false);

        if (!self && peers.length === 0) {
            const item = new PopupMenu.PopupMenuItem('No devices', {
                reactive: false,
                can_focus: false,
            });
            this._devicesSection.addMenuItem(item);
        }
    }

    _addDeviceItem(device, isSelf) {
        // Prefer the MagicDNS name (matches the admin console); many phones
        // report "localhost" as their local HostName.
        const dnsName = device.DNSName ? device.DNSName.split('.')[0] : '';
        const name = dnsName || device.HostName || 'unknown';
        const ip = (device.TailscaleIPs && device.TailscaleIPs[0]) || '';
        const online = !!device.Online;

        const item = new PopupMenu.PopupBaseMenuItem();
        item.add_style_class_name('ts-device-item');

        const dot = new St.Icon({
            icon_name: 'media-record-symbolic',
            style_class: online ? 'ts-dot-online' : 'ts-dot-offline',
            icon_size: 10,
            y_align: Clutter.ActorAlign.CENTER,
        });
        item.add_child(dot);

        const label = new St.Label({
            text: isSelf ? `${name} (this device)` : name,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        item.add_child(label);

        if (ip) {
            const ipLabel = new St.Label({
                text: ip,
                style_class: 'ts-ip-label',
                y_align: Clutter.ActorAlign.CENTER,
            });
            item.add_child(ipLabel);

            item.connect('activate', () => {
                St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, ip);
                Main.notify('Tailscale', `Copied ${ip} (${name})`);
            });
        } else {
            item.reactive = false;
        }

        this._devicesSection.addMenuItem(item);
    }
});

export default class TailscaleExtension extends Extension {
    enable() {
        this._button = new TailscaleButton();
        Main.panel.addToStatusArea('tailscale-toggle', this._button, 0, 'right');
        this._placeButton();

        // Refresh on demand only: once now, then whenever the menu opens or a
        // toggle completes (both emit 'request-refresh'). No background polling.
        this._button.connect('request-refresh', () => this._refresh());
        this._refresh();
    }

    // Position the button between the weather indicator and mess-menu:
    // weather | tailscale | mess-menu. Anchor to mess-menu (place just to its
    // left); fall back to sitting right after weather.
    _placeButton() {
        const sa = Main.panel.statusArea;
        const container = this._button.container;
        if (!container)
            return;

        const findByRole = (re) => {
            for (const role in sa) {
                if (re.test(role) && sa[role]?.container)
                    return sa[role];
            }
            return null;
        };

        const mess = findByRole(/mess/i);
        const weather = findByRole(/weather|meteo/i);

        const moveInto = (box, place) => {
            const parent = container.get_parent();
            if (parent && parent !== box)
                parent.remove_child(container);
            if (container.get_parent() !== box)
                box.add_child(container);
            place(box);
        };

        if (mess) {
            const box = mess.container.get_parent();
            if (box)
                moveInto(box, b => b.set_child_below_sibling(container, mess.container));
        } else if (weather) {
            const box = weather.container.get_parent();
            if (box)
                moveInto(box, b => b.set_child_above_sibling(container, weather.container));
        }
    }

    async _refresh() {
        const res = await runCommand(['tailscale', 'status', '--json']);
        if (!this._button)
            return;
        if (res.ok && res.stdout) {
            try {
                this._button.update(JSON.parse(res.stdout));
                return;
            } catch (e) {
                // fall through to error reporting
            }
        }
        // Status read failed — surface why (daemon down, no access, …).
        this._button.update({
            BackendState: 'Problem',
            _problem: failureKind(res) || 'daemon-down',
        });
    }

    disable() {
        this._button?.destroy();
        this._button = null;
    }
}
