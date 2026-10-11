/**
 * TYRAVEX Web Serial API Manager
 * Handles USB serial communication with ESP32 microcontrollers.
 * Robust streaming, line buffering, JSON validation, and clean lifecycle management.
 */

class TyravexSerialManager {
  constructor() {
    this.port = null;
    this.reader = null;
    this.readableStreamClosed = null;
    this.keepReading = false;
    this.isConnected = false;
    this.baudRate = 115200;
    this.lineBuffer = '';
    this.portInfo = null;

    // Callbacks
    this.onConnectCallback = null;
    this.onDisconnectCallback = null;
    this.onDataCallback = null;
    this.onErrorCallback = null;
    this.onStatusChangeCallback = null;

    // Monitor browser disconnect event (e.g. physical cable unplug)
    if (this.isSupported()) {
      navigator.serial.addEventListener('disconnect', (event) => {
        if (this.port && event.target === this.port) {
          this.handleUnexpectedDisconnect('Hardware disconnected (USB cable unplugged)');
        }
      });
    }
  }

  /**
   * Check if the current browser environment supports the Web Serial API.
   * @returns {boolean}
   */
  isSupported() {
    return 'serial' in navigator;
  }

  /**
   * Register event listeners
   */
  on(event, callback) {
    if (event === 'connect') this.onConnectCallback = callback;
    if (event === 'disconnect') this.onDisconnectCallback = callback;
    if (event === 'data') this.onDataCallback = callback;
    if (event === 'error') this.onErrorCallback = callback;
    if (event === 'statusChange') this.onStatusChangeCallback = callback;
  }

  /**
   * Trigger status update
   */
  _emitStatus(status, details = '') {
    if (this.onStatusChangeCallback) {
      this.onStatusChangeCallback(status, details);
    }
  }

  /**
   * Requests permission and connects to the user-selected serial port.
   * @param {number} baudRate Baud rate, default 115200
   * @returns {Promise<boolean>}
   */
  async connect(baudRate = 115200) {
    if (!this.isSupported()) {
      const err = new Error(
        'Web Serial API is not supported in this browser. Please use a desktop browser such as Google Chrome, Microsoft Edge, or Opera.'
      );
      if (this.onErrorCallback) this.onErrorCallback(err.message);
      throw err;
    }

    if (this.isConnected) {
      console.warn('[TYRAVEX Serial] Already connected. Please disconnect first.');
      return true;
    }

    try {
      this._emitStatus('REQUESTING_PERMISSION', 'Waiting for port selection...');
      
      // Prompt user to select port via standard browser UI
      // Filter options can be provided, but keeping open allows any ESP32 / CH340 / CP2102 UART
      this.port = await navigator.serial.requestPort();

      this.baudRate = parseInt(baudRate, 10) || 115200;
      this._emitStatus('OPENING_PORT', `Opening serial port at ${this.baudRate} baud...`);

      // Open port with configured serial parameters
      await this.port.open({
        baudRate: this.baudRate,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        bufferSize: 8192,
        flowControl: 'none'
      });

      // Extract vendor / product IDs if provided by the driver
      const info = this.port.getInfo ? this.port.getInfo() : {};
      this.portInfo = {
        usbVendorId: info.usbVendorId ? `0x${info.usbVendorId.toString(16).padStart(4, '0').toUpperCase()}` : 'Standard USB-UART',
        usbProductId: info.usbProductId ? `0x${info.usbProductId.toString(16).padStart(4, '0').toUpperCase()}` : 'ESP32 Device',
        baudRate: this.baudRate,
        openedAt: new Date().toISOString()
      };

      this.isConnected = true;
      this.keepReading = true;
      this.lineBuffer = '';

      if (this.onConnectCallback) {
        this.onConnectCallback(this.portInfo);
      }
      this._emitStatus('CONNECTED', `Connected to ${this.portInfo.usbProductId} @ ${this.baudRate} baud`);

      // Start continuous background read loop
      this._startReadLoop();
      return true;
    } catch (err) {
      this.isConnected = false;
      this.port = null;
      
      // User cancelled dialog or port open failed
      const msg = err.name === 'NotFoundError'
        ? 'No serial port selected.'
        : `Connection failed: ${err.message}`;
      
      if (this.onErrorCallback) this.onErrorCallback(msg);
      this._emitStatus('DISCONNECTED', msg);
      return false;
    }
  }

  /**
   * Internal read loop handling chunk decoding and line buffering
   */
  async _startReadLoop() {
    // Pipe through TextDecoder to decode UTF-8 bytes to string
    const textDecoder = new TextDecoderStream();
    this.readableStreamClosed = this.port.readable.pipeTo(textDecoder.writable);
    this.reader = textDecoder.readable.getReader();

    try {
      while (this.keepReading) {
        const { value, done } = await this.reader.read();
        if (done) {
          // Reader was cancelled or stream reached EOF
          break;
        }

        if (value) {
          this._processChunk(value);
        }
      }
    } catch (err) {
      if (this.keepReading) {
        console.error('[TYRAVEX Serial] Read loop error:', err);
        this.handleUnexpectedDisconnect(`Read error: ${err.message}`);
      }
    } finally {
      try {
        this.reader.releaseLock();
      } catch (e) {
        // Ignored
      }
    }
  }

  /**
   * Accumulates chunks and extracts newline-delimited strings
   * @param {string} chunk Incoming string piece
   */
  _processChunk(chunk) {
    this.lineBuffer += chunk;

    // Guard against runaway buffer if newline is absent
    if (this.lineBuffer.length > 16384) {
      console.warn('[TYRAVEX Serial] Line buffer exceeded 16KB without newline. Truncating.');
      this.lineBuffer = this.lineBuffer.slice(-2048);
    }

    let newlineIndex;
    while ((newlineIndex = this.lineBuffer.indexOf('\n')) >= 0) {
      const line = this.lineBuffer.slice(0, newlineIndex).trim();
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);

      if (line.length > 0) {
        this._handleSerialLine(line);
      }
    }
  }

  /**
   * Validates and parses a single newline-delimited JSON line
   * @param {string} line Raw string line
   */
  _handleSerialLine(line) {
    // Ignore pure diagnostic comments starting with '#' or '//'
    if (line.startsWith('#') || line.startsWith('//')) {
      console.info('[ESP32 Log]', line);
      return;
    }

    // Check if line looks like JSON
    if (line.startsWith('{') && line.endsWith('}')) {
      try {
        const parsed = JSON.parse(line);
        if (this.onDataCallback) {
          this.onDataCallback(parsed, line);
        }
      } catch (jsonErr) {
        console.warn('[TYRAVEX Serial] Malformed JSON received:', line, jsonErr.message);
        if (this.onErrorCallback) {
          this.onErrorCallback(`Malformed JSON: ${line.substring(0, 40)}...`);
        }
      }
    } else {
      // Non-JSON debug message from firmware (e.g. "ESP32 Booting...")
      console.info('[ESP32 Diagnostic]:', line);
    }
  }

  /**
   * Disconnects and releases all serial streams and locks cleanly.
   * @returns {Promise<boolean>}
   */
  async disconnect() {
    if (!this.isConnected && !this.port) {
      return true;
    }

    this._emitStatus('DISCONNECTING', 'Closing serial connection...');
    this.keepReading = false;

    try {
      if (this.reader) {
        await this.reader.cancel();
      }

      if (this.readableStreamClosed) {
        await this.readableStreamClosed.catch(() => {
          /* Ignore abort errors */
        });
      }

      if (this.port) {
        await this.port.close();
      }
    } catch (err) {
      console.warn('[TYRAVEX Serial] Error closing port:', err);
    } finally {
      this.port = null;
      this.reader = null;
      this.readableStreamClosed = null;
      this.isConnected = false;
      this.lineBuffer = '';
      this.portInfo = null;

      this._emitStatus('DISCONNECTED', 'Serial port closed.');
      if (this.onDisconnectCallback) {
        this.onDisconnectCallback('User disconnected');
      }
    }

    return true;
  }

  /**
   * Handles spontaneous cable detachment or hardware reset
   */
  handleUnexpectedDisconnect(reason) {
    this.keepReading = false;
    this.isConnected = false;
    this.port = null;
    this.reader = null;
    this.readableStreamClosed = null;
    this.lineBuffer = '';

    this._emitStatus('DISCONNECTED', reason);
    if (this.onDisconnectCallback) {
      this.onDisconnectCallback(reason);
    }
  }
}

// Export singleton instance to window
window.tyravexSerial = new TyravexSerialManager();
