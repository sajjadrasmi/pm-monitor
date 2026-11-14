// Connection manager for PM boxes: Bluetooth LE (Nordic UART) and USB (Web Serial).
// Several boxes can be connected at the same time.
import { LineBuffer, parseLine } from './parser.js';

export const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // app -> box (write)
const NUS_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // box -> app (notify)

export const HAS_BLE = typeof navigator !== 'undefined' && 'bluetooth' in navigator;
export const HAS_SERIAL = typeof navigator !== 'undefined' && 'serial' in navigator;

const sleep = ms => new Promise(r => setTimeout(r, ms));
let nextId = 1;

export class DeviceManager extends EventTarget {
  constructor() {
    super();
    this.devices = new Map();          // id -> device object
  }

  // ---- events: 'change' (list/state), 'reading' ({dev, r, t, legacy}), 'log' ({dev, level, text}) ----
  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  log(dev, level, text) { this._emit('log', { dev, level, text }); }
  _changed() { this._emit('change', {}); }

  _newDevice(transport, name) {
    const dev = {
      id: 'd' + (nextId++), transport, name: name || (transport === 'usb' ? 'USB box' : 'Box'),
      state: 'connecting', fw: '', last: null, lastAt: 0, rx: 0, legacy: false,
      warned: {}, lines: new LineBuffer(), userClosed: false,
    };
    this.devices.set(dev.id, dev);
    this._changed();
    return dev;
  }

  _setState(dev, state) { dev.state = state; this._changed(); }

  _handleText(dev, text) {
    for (const line of dev.lines.push(text)) this._handleLine(dev, line);
  }

  _handleLine(dev, line) {
    const m = parseLine(line);
    if (!m) return;
    if (m.type === 'aq' || m.type === 'legacy') {
      dev.rx++; dev.last = m.r; dev.lastAt = Date.now();
      if (m.type === 'legacy' && !dev.legacy) {
        dev.legacy = true;
        this.log(dev, 'warn', 'This box runs the OLD firmware (text output, no Bluetooth, no particle counts). ' +
          'It works over USB, but please flash PM_BOX_Firmware.ino to enable Bluetooth.');
      }
      if (dev.state !== 'connected') this._setState(dev, 'connected');
      this._emit('reading', { dev, r: m.r, t: dev.lastAt, legacy: m.type === 'legacy' });
      this._changed();
    } else if (m.type === 'env') {
      dev.env = { temp: m.t, rh: m.rh, at: Date.now() };
      this._changed();
    } else if (m.type === 'sys') {
      dev.sys = { vbat: m.vbat, rssi: m.rssi, uptime: m.uptime, sht: m.sht, at: Date.now() };
      this._changed();
    } else if (m.type === 'info') {
      if (m.box && m.box !== dev.name) {
        if (dev.transport === 'usb' || !dev.name || dev.name === 'Box') dev.name = m.box;
        dev.boxId = m.box;
      }
      if (m.fw) dev.fw = m.fw;
      this._changed();
    } else if (m.type === 'msg') {
      if (m.text.startsWith('NO_SENSOR_DATA')) {
        if (!dev.warned.sensor) {
          dev.warned.sensor = true;
          this.log(dev, 'err', 'The box is connected but the PMS5003 sensor sends nothing. Check: ' +
            '(1) the sensor gets 5 V (the XIAO "VUSB" pin has 5 V ONLY when USB is plugged in, not on battery); ' +
            '(2) PMS TXD wire goes to D7; (3) GND is shared.');
        }
        dev.sensorError = true; this._changed();
      } else {
        this.log(dev, m.level === 'err' ? 'err' : 'info', 'box: ' + m.text);
      }
    } else if (m.type === 'bad' && !dev.warned.bad) {
      dev.warned.bad = true;
      this.log(dev, 'warn', 'Ignored a damaged line: ' + JSON.stringify(m.text).slice(0, 80));
    }
  }

  _watchdog(dev) {
    // If nothing useful arrives soon after connecting, explain why.
    setTimeout(() => {
      if (!this.devices.has(dev.id) || dev.rx > 0 || dev.userClosed) return;
      if (dev.state === 'connected' || dev.state === 'connecting') {
        this.log(dev, 'warn', dev.transport === 'ble'
          ? 'Connected, but no readings after 8 s. Possible causes: sensor not powered (5 V), ' +
            'the box is also open in another app (nRF Connect, a second browser tab), or old firmware.'
          : 'USB port open, but no readings after 8 s. Possible causes: wrong port selected, ' +
            'the Arduino Serial Monitor is open, or the sensor is not powered.');
      }
    }, 8000);
  }

  // ================= Bluetooth =================
  async connectBLE({ showAll = false } = {}) {
    if (!HAS_BLE) throw new Error('This browser has no Web Bluetooth. Use Chrome or Edge (PC) or Chrome (Android).');
    const options = showAll
      ? { acceptAllDevices: true, optionalServices: [NUS_SERVICE, 'device_information'] }
      : { filters: [{ services: [NUS_SERVICE] }, { namePrefix: 'PM-BOX' }, { namePrefix: 'XIAO' }],
          optionalServices: [NUS_SERVICE, 'device_information'] };
    let bt;
    try { bt = await navigator.bluetooth.requestDevice(options); }
    catch (e) {
      if (e.name === 'NotFoundError') return null;          // user closed the chooser
      throw e;
    }
    // Same box selected again? reuse it.
    for (const d of this.devices.values()) {
      if (d.bt && d.bt.id === bt.id) {
        if (d.state === 'connected') return d;
        d.userClosed = false; this._bleConnectLoop(d); return d;
      }
    }
    const dev = this._newDevice('ble', bt.name || 'Box');
    dev.bt = bt;
    bt.addEventListener('gattserverdisconnected', () => this._onBleDisconnected(dev));
    await this._bleConnectLoop(dev, true);
    return dev;
  }

  async _bleConnectOnce(dev) {
    const server = await dev.bt.gatt.connect();
    let svc;
    try { svc = await server.getPrimaryService(NUS_SERVICE); }
    catch (e) {
      throw Object.assign(new Error('This Bluetooth device has no PM-box data service (Nordic UART). ' +
        'Is it really a PM box with the new firmware?'), { fatal: true });
    }
    const chars = await svc.getCharacteristics();
    const tx = chars.find(c => c.uuid === NUS_TX) || chars.find(c => c.properties.notify);
    if (!tx) throw Object.assign(new Error('No notify characteristic in the UART service.'), { fatal: true });
    dev.rxChar = chars.find(c => c.uuid === NUS_RX) || null;
    const dec = new TextDecoder();
    if (!dev._onNotify) {
      dev._onNotify = ev => this._handleText(dev, dec.decode(ev.target.value, { stream: true }));
    }
    tx.removeEventListener('characteristicvaluechanged', dev._onNotify);
    tx.addEventListener('characteristicvaluechanged', dev._onNotify);
    await tx.startNotifications();
    dev.txChar = tx;
    this._setState(dev, 'connected');
    this.log(dev, 'ok', 'Bluetooth connected, waiting for data…');
    this._send(dev, 'ID\n');
    this._watchdog(dev);
  }

  // Android often fails the first GATT connect ("GATT error 133") -> retry with backoff.
  async _bleConnectLoop(dev, firstTime = false) {
    if (dev._looping) return;
    dev._looping = true;
    let attempt = 0;
    try {
      while (!dev.userClosed && this.devices.has(dev.id)) {
        attempt++;
        this._setState(dev, attempt === 1 && firstTime ? 'connecting' : 'reconnecting');
        try {
          await this._bleConnectOnce(dev);
          return;
        } catch (e) {
          if (e.fatal) { this.log(dev, 'err', e.message); dev.userClosed = true; this._setState(dev, 'failed'); return; }
          this.log(dev, 'warn', `Bluetooth attempt ${attempt} failed: ${e.message}`);
          if (firstTime && attempt >= 4) {
            this.log(dev, 'err', 'Could not connect. Move the phone/PC closer, make sure the box is ON and ' +
              'not connected to another phone or tab, then press Connect again.');
            dev.userClosed = true;
            this._setState(dev, 'failed');
            return;
          }
          await sleep(Math.min(30000, 1500 * attempt));
        }
      }
    } finally { dev._looping = false; }
  }

  _onBleDisconnected(dev) {
    if (dev.userClosed) { this._setState(dev, 'disconnected'); return; }
    this.log(dev, 'warn', 'Bluetooth link lost — reconnecting automatically…');
    this._bleConnectLoop(dev);
  }

  // ================= USB (Web Serial) =================
  async connectUSB() {
    if (!HAS_SERIAL) throw new Error('This browser has no Web Serial (USB). Use Chrome or Edge on PC, or Chrome 148+ on Android.');
    let port;
    try { port = await navigator.serial.requestPort(); }
    catch (e) {
      if (e.name === 'NotFoundError') return null;          // chooser closed
      throw e;
    }
    const dev = this._newDevice('usb', 'USB box');
    dev.port = port;
    try {
      await port.open({ baudRate: 115200, bufferSize: 4096 });
    } catch (e) {
      this.devices.delete(dev.id); this._changed();
      throw new Error('Could not open the USB port (' + e.message + '). Close the Arduino IDE Serial Monitor ' +
        'or any other program/tab using this box, then try again.');
    }
    try { await port.setSignals({ dataTerminalReady: true, requestToSend: true }); } catch (_) {}
    this._setState(dev, 'connected');
    this.log(dev, 'ok', 'USB port open, waiting for data…');
    this._usbReadLoop(dev);
    this._send(dev, 'ID\n');
    this._watchdog(dev);
    return dev;
  }

  async _usbReadLoop(dev) {
    const dec = new TextDecoder();
    while (dev.port && dev.port.readable && !dev.userClosed) {
      dev.reader = dev.port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await dev.reader.read();
          if (done) break;
          if (value) this._handleText(dev, dec.decode(value, { stream: true }));
        }
      } catch (e) {
        if (!dev.userClosed) this.log(dev, 'warn', 'USB read error: ' + e.message);
      } finally {
        try { dev.reader.releaseLock(); } catch (_) {}
      }
    }
    if (!dev.userClosed) {
      this.log(dev, 'err', 'USB cable disconnected.');
      this._setState(dev, 'disconnected');
    }
  }

  // ================= demo box (dev mode only) =================
  connectDemo(name = 'PM-BOX-DEMO') {
    const dev = this._newDevice('demo', name);
    this._setState(dev, 'connected');
    let k = 0;
    dev.timer = setInterval(() => {
      k++;
      const base = 8 + 6 * Math.sin(k / 15) + Math.random() * 2;
      const v = x => Math.max(0, Math.round(x));
      const line = `AQ,${v(base * .7)},${v(base)},${v(base * 1.3)},${v(base * .7)},${v(base)},${v(base * 1.3)},` +
        `${v(base * 120)},${v(base * 35)},${v(base * 6)},${v(base * .8)},${v(base * .2)},${v(base * .05)}\n`;
      let extra = '';
      if (k % 5 === 1) {
        extra = `ENV,${(22 + 2 * Math.sin(k / 40)).toFixed(2)},${(48 + 10 * Math.sin(k / 25)).toFixed(1)}\n` +
                `SYS,${3900 - k},${-55 - Math.round(Math.random() * 15)},${k},1\n`;
      }
      this._handleText(dev, (k === 1 ? `INFO,BOX,${name},FW,2.1\n` : '') + extra + line);
    }, 1000);
    return dev;
  }

  // ================= common =================
  async _send(dev, text) {
    try {
      const data = new TextEncoder().encode(text);
      if (dev.transport === 'ble' && dev.rxChar) {
        if (dev.rxChar.writeValueWithoutResponse) await dev.rxChar.writeValueWithoutResponse(data);
        else await dev.rxChar.writeValue(data);
      } else if (dev.transport === 'usb' && dev.port && dev.port.writable) {
        const w = dev.port.writable.getWriter();
        await w.write(data); w.releaseLock();
      }
    } catch (_) { /* old firmware ignores commands — fine */ }
  }

  async disconnect(id) {
    const dev = this.devices.get(id);
    if (!dev) return;
    dev.userClosed = true;
    try {
      if (dev.transport === 'ble' && dev.bt && dev.bt.gatt.connected) dev.bt.gatt.disconnect();
      if (dev.transport === 'usb') {
        try { await dev.reader?.cancel(); } catch (_) {}
        try { await dev.port?.close(); } catch (_) {}
      }
      if (dev.timer) clearInterval(dev.timer);
    } finally {
      this.devices.delete(id);
      this._changed();
    }
  }

  async disconnectAll() { for (const id of [...this.devices.keys()]) await this.disconnect(id); }

  reconnect(id) {
    const dev = this.devices.get(id);
    if (dev && dev.transport === 'ble') { dev.userClosed = false; this._bleConnectLoop(dev); }
  }

  list() { return [...this.devices.values()]; }
}

// USB cable pulled out (whole port gone)
if (HAS_SERIAL) {
  navigator.serial.addEventListener('disconnect', () => { /* read loop reports it */ });
}
