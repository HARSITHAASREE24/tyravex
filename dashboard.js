/**
 * TYRAVEX Telemetry & Monitoring Engine
 * Telemetry processor for:
 * 1. DHT11: Ambient Temperature (°C) & Humidity (%RH)
 * 2. BMP280: Tire Pressure (PSI / bar / kPa / hPa)
 * 3. Vibration Sensor: Analog Raw (0-4095) & Digital Events
 * 4. HX711 Load Cell: Suspension / Tire Applied Load (kg / N / Raw)
 */

class TyravexDashboardEngine {
  constructor() {
    this.storageKey = 'tyravex_user_settings_v3';
    this.settings = this.loadSettings();

    // Live Telemetry State
    this.state = {
      isConnected: false,
      isDemoMode: false,
      portInfo: null,
      lastPacketTime: null,
      packetCount: 0,
      invalidPacketCount: 0,
      commErrors: 0,

      // 1. DHT11: Ambient Temperature & Humidity
      temperature: null,          // °C
      temperatureValid: false,
      tempMin: null,
      tempMax: null,
      recentTemps: [],
      tempTrend: 'STABLE',
      humidity: null,             // %RH
      humidityValid: false,
      humidityStatus: 'NO DATA',
      dht11Valid: false,

      // 2. Tire Pressure
      tirePressureHpa: null,      // Base reading in hPa
      tirePressureDisplay: null,  // In user's chosen unit (PSI / bar / kPa / hPa)
      pressureValid: false,
      recentPressures: [],
      pressureTrend: 'STEADY',
      bmp280Valid: false,

      // 3. Vibration Sensor (AO & DO)
      vibrationRaw: null,         // 0 - 4095 ADC
      vibrationNormalized: null,  // 0 - 100%
      vibrationDigital: 0,        // 0 (quiet) or 1 (trigger)
      vibrationDigitalStatus: 'QUIET',
      vibrationEventCount: 0,
      peakVibrationRaw: 0,
      recentVibrations: [],
      vibrationStatus: 'AWAITING',
      vibrationAnalogValid: false,
      vibrationDigitalValid: false,

      // 4. HX711 & 10 kg Load Cell (Suspension Load on Tire)
      loadKg: null,
      loadN: null,
      loadRaw: 0,
      loadCalibrated: false,
      loadValid: false,
      hx711Valid: false,
      peakLoadKg: null,
      minLoadKg: null,
      recentLoads: [],
      loadTrend: 'STABLE',
      loadStatus: 'READY',

      // 5. Overall Monitoring Status
      healthScore: null,
      healthStatus: 'INSUFFICIENT DATA', // NORMAL, WARNING, CRITICAL, INSUFFICIENT DATA
      healthCondition: 'Awaiting Hardware Telemetry',
      activeWarnings: []
    };

    // Live Chart Datasets (5 streams)
    this.isChartPaused = false;
    this.chartData = {
      labels: [],
      temperature: [],
      humidity: [],
      pressure: [],
      vibration: [],
      load: []
    };

    // Live Event Log (max 200 items in memory)
    this.eventLogs = [];
    this.activeLogFilter = 'ALL';

    // Listener callbacks
    this.subscribers = new Set();

    // Check for stale readings every second
    this.staleCheckInterval = setInterval(() => this.checkStaleData(), 1000);
  }

  /**
   * Load user configurable settings with safety defaults
   */
  loadSettings() {
    const defaults = {
      // DHT11 Ambient thermal limits
      tempWarnC: 45.0,
      tempCritC: 60.0,
      humidityWarnLow: 25.0,
      humidityWarnHigh: 80.0,

      // Tire Pressure preferred display unit
      pressureUnit: 'PSI', // 'PSI', 'bar', 'kPa', 'hPa'
      targetTirePressurePsi: 32.0,

      // Vibration Sensor Limits (12-bit ADC raw 0-4095)
      vibrationWarnRaw: 1800,
      vibrationCritRaw: 3000,

      // Suspension Load on Tire (10 kg max rated load cell)
      loadWarnKg: 7.5,
      loadCritKg: 9.5,
      loadDisplayUnit: 'kg', // 'kg' or 'N'
      loadTareOffset: 24500,
      loadScaleFactor: 21500,

      // Buffer & Alert parameters
      chartHistoryLength: 40,
      staleTimeoutSeconds: 4,
      baudRate: 115200
    };

    try {
      const stored = localStorage.getItem(this.storageKey);
      if (stored) {
        return { ...defaults, ...JSON.parse(stored) };
      }
    } catch (e) {
      console.warn('[TYRAVEX Engine] Could not load stored settings:', e);
    }
    return defaults;
  }

  /**
   * Save settings and trigger re-evaluation
   */
  saveSettings(newSettings) {
    this.settings = { ...this.settings, ...newSettings };
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(this.settings));
    } catch (e) {
      console.error('[TYRAVEX Engine] Could not save settings:', e);
    }
    this.recomputeMonitoringStatus();
    this.notify();
  }

  /**
   * Subscribe UI components to telemetry updates
   */
  subscribe(callback) {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  notify() {
    for (const callback of this.subscribers) {
      try {
        callback(this.state, this.chartData, this.eventLogs);
      } catch (err) {
        console.error('[TYRAVEX Engine] Subscriber callback error:', err);
      }
    }
  }

  /**
   * Pressure unit conversion helper from hPa to target unit
   */
  static convertPressureFromHpa(hpaVal, toUnit) {
    if (hpaVal === null || isNaN(hpaVal)) return null;
    switch (toUnit) {
      case 'PSI':
        return Number((hpaVal * 0.01450377).toFixed(1));
      case 'bar':
        return Number((hpaVal * 0.001).toFixed(2));
      case 'kPa':
        return Number((hpaVal * 0.1).toFixed(1));
      case 'hPa':
      default:
        return Number(hpaVal.toFixed(1));
    }
  }

  /**
   * Ingest raw parsed packet from ESP32 or Demo generator
   */
  processPacket(packet) {
    if (!packet || typeof packet !== 'object') {
      this.state.invalidPacketCount++;
      return;
    }

    this.state.packetCount++;
    this.state.lastPacketTime = Date.now();

    // 1. Process DHT11 Temperature & Humidity
    this.state.dht11Valid = Boolean(packet.dht11_valid);
    if (this.state.dht11Valid && packet.temperature_c !== null && !isNaN(packet.temperature_c)) {
      const tempVal = Number(packet.temperature_c);
      if (tempVal >= -20 && tempVal <= 70) {
        this.state.temperature = tempVal;
        this.state.temperatureValid = true;

        if (this.state.tempMin === null || tempVal < this.state.tempMin) this.state.tempMin = tempVal;
        if (this.state.tempMax === null || tempVal > this.state.tempMax) this.state.tempMax = tempVal;

        this.state.recentTemps.push(tempVal);
        if (this.state.recentTemps.length > 10) this.state.recentTemps.shift();

        if (this.state.recentTemps.length >= 3) {
          const delta = this.state.recentTemps[this.state.recentTemps.length - 1] - this.state.recentTemps[0];
          if (delta > 0.5) this.state.tempTrend = 'RISING';
          else if (delta < -0.5) this.state.tempTrend = 'FALLING';
          else this.state.tempTrend = 'STABLE';
        }
      } else {
        this.state.temperature = null;
        this.state.temperatureValid = false;
      }
    } else {
      this.state.temperature = null;
      this.state.temperatureValid = false;
    }

    if (this.state.dht11Valid && packet.humidity_percent !== null && !isNaN(packet.humidity_percent)) {
      const humVal = Number(packet.humidity_percent);
      if (humVal >= 0 && humVal <= 100) {
        this.state.humidity = humVal;
        this.state.humidityValid = true;
        if (humVal > this.settings.humidityWarnHigh) {
          this.state.humidityStatus = 'HIGH HUMIDITY';
        } else if (humVal < this.settings.humidityWarnLow) {
          this.state.humidityStatus = 'DRY AIR';
        } else {
          this.state.humidityStatus = 'OPTIMAL';
        }
      } else {
        this.state.humidity = null;
        this.state.humidityValid = false;
        this.state.humidityStatus = 'INVALID';
      }
    } else {
      this.state.humidity = null;
      this.state.humidityValid = false;
      this.state.humidityStatus = this.state.isConnected ? 'SENSOR FAULT' : 'NO DATA';
    }

    // 2. Process Tire Pressure (BMP280)
    this.state.bmp280Valid = Boolean(packet.bmp280_valid);
    const rawHpa = packet.tire_pressure_hpa !== undefined
      ? packet.tire_pressure_hpa
      : packet.atmospheric_pressure_hpa;

    if (this.state.bmp280Valid && rawHpa !== null && !isNaN(rawHpa)) {
      const pressVal = Number(rawHpa);
      if (pressVal >= 300 && pressVal <= 1400) {
        this.state.tirePressureHpa = pressVal;
        this.state.tirePressureDisplay = TyravexDashboardEngine.convertPressureFromHpa(pressVal, this.settings.pressureUnit);
        this.state.pressureValid = true;

        this.state.recentPressures.push(pressVal);
        if (this.state.recentPressures.length > 10) this.state.recentPressures.shift();

        if (this.state.recentPressures.length >= 3) {
          const delta = this.state.recentPressures[this.state.recentPressures.length - 1] - this.state.recentPressures[0];
          if (delta > 0.8) this.state.pressureTrend = 'RISING';
          else if (delta < -0.8) this.state.pressureTrend = 'FALLING';
          else this.state.pressureTrend = 'STEADY';
        }
      } else {
        this.state.tirePressureHpa = null;
        this.state.tirePressureDisplay = null;
        this.state.pressureValid = false;
      }
    } else {
      this.state.tirePressureHpa = null;
      this.state.tirePressureDisplay = null;
      this.state.pressureValid = false;
    }

    // 3. Process Vibration Sensor (AO & DO)
    this.state.vibrationAnalogValid = Boolean(packet.vibration_analog_valid);
    this.state.vibrationDigitalValid = Boolean(packet.vibration_digital_valid);

    if (this.state.vibrationAnalogValid && packet.vibration_analog_raw !== null && !isNaN(packet.vibration_analog_raw)) {
      const raw = Math.max(0, Math.min(4095, Number(packet.vibration_analog_raw)));
      this.state.vibrationRaw = raw;
      this.state.vibrationNormalized = Math.round((raw / 4095) * 100);

      if (raw > this.state.peakVibrationRaw) {
        this.state.peakVibrationRaw = raw;
      }

      this.state.recentVibrations.push(raw);
      if (this.state.recentVibrations.length > 20) this.state.recentVibrations.shift();

      if (raw >= this.settings.vibrationCritRaw) {
        this.state.vibrationStatus = 'CRITICAL VIBRATION';
      } else if (raw >= this.settings.vibrationWarnRaw) {
        this.state.vibrationStatus = 'ELEVATED';
      } else {
        this.state.vibrationStatus = 'NOMINAL';
      }
    } else {
      this.state.vibrationRaw = null;
      this.state.vibrationNormalized = null;
      this.state.vibrationStatus = 'NO DATA';
    }

    this.state.vibrationDigital = packet.vibration_digital ? 1 : 0;
    this.state.vibrationDigitalStatus = this.state.vibrationDigital === 1 ? 'ACTIVE (PULSE)' : 'QUIET';
    this.state.vibrationEventCount = Number(packet.vibration_event_count) || 0;

    // 4. Process HX711 Suspension / Tire Applied Load
    this.state.hx711Valid = Boolean(packet.hx711_valid);
    this.state.loadCalibrated = Boolean(packet.load_calibrated);
    this.state.loadRaw = packet.load_raw ? Number(packet.load_raw) : 0;

    // Determine loadKg: either directly from packet.load_kg or calculate from load_raw
    let calculatedKg = null;
    if (packet.load_kg !== null && !isNaN(packet.load_kg)) {
      calculatedKg = Number(packet.load_kg);
    } else if (this.state.loadRaw > 0) {
      // Calculate from raw counts using tare offset and scale factor
      // Default offset ~24500, scale ~21500 per kg
      const tare = this.settings.loadTareOffset || 24500;
      const scale = this.settings.loadScaleFactor || 21500;
      calculatedKg = (this.state.loadRaw - tare) / scale;
    }

    if (this.state.hx711Valid && calculatedKg !== null && !isNaN(calculatedKg)) {
      const loadKgVal = Math.max(0, calculatedKg);
      this.state.loadKg = Number(loadKgVal.toFixed(2));
      this.state.loadN = Number((loadKgVal * 9.80665).toFixed(2));
      this.state.loadValid = true;

      if (this.state.peakLoadKg === null || loadKgVal > this.state.peakLoadKg) {
        this.state.peakLoadKg = Number(loadKgVal.toFixed(2));
      }
      if (this.state.minLoadKg === null || loadKgVal < this.state.minLoadKg) {
        this.state.minLoadKg = Number(loadKgVal.toFixed(2));
      }

      this.state.recentLoads.push(loadKgVal);
      if (this.state.recentLoads.length > 10) this.state.recentLoads.shift();

      if (this.state.recentLoads.length >= 3) {
        const delta = this.state.recentLoads[this.state.recentLoads.length - 1] - this.state.recentLoads[0];
        if (delta > 0.25) this.state.loadTrend = 'INCREASING';
        else if (delta < -0.25) this.state.loadTrend = 'DECREASING';
        else this.state.loadTrend = 'STABLE';
      }

      if (loadKgVal >= this.settings.loadCritKg) {
        this.state.loadStatus = 'OVERLOAD (> 9.5 kg)';
      } else if (loadKgVal >= this.settings.loadWarnKg) {
        this.state.loadStatus = 'HIGH LOAD';
      } else {
        this.state.loadStatus = 'NOMINAL';
      }
    } else {
      this.state.loadKg = null;
      this.state.loadN = null;
      this.state.loadValid = false;
      this.state.loadStatus = this.state.isConnected ? 'AMPLIFIER FAULT' : 'NO DATA';
    }

    // 5. Recompute Monitoring Status
    this.recomputeMonitoringStatus();

    // 6. Append to Live Chart History
    if (!this.isChartPaused) {
      this.appendChartData();
    }

    // 7. Evaluate Automated Alerts
    this.evaluateAlerts();

    // 8. Notify UI subscribers
    this.notify();
  }

  /**
   * Recompute Overall Monitoring Status
   */
  recomputeMonitoringStatus() {
    const warnings = [];
    const validCount = (this.state.temperatureValid ? 1 : 0) +
                       (this.state.pressureValid ? 1 : 0) +
                       (this.state.vibrationAnalogValid && this.state.vibrationRaw !== null ? 1 : 0) +
                       (this.state.loadValid ? 1 : 0);

    if (!this.state.lastPacketTime || validCount === 0) {
      this.state.healthScore = null;
      this.state.healthStatus = 'INSUFFICIENT DATA';
      this.state.healthCondition = 'Awaiting Telemetry Stream';
      this.state.activeWarnings = ['Connect ESP32 or activate Demo Mode.'];
      return;
    }

    if (!this.state.temperatureValid) {
      warnings.push('DHT11 Temperature sensor offline.');
    }
    if (!this.state.pressureValid) {
      warnings.push('Tire Pressure sensor (BMP280) offline.');
    }
    if (this.state.vibrationRaw === null) {
      warnings.push('Vibration sensor module reading unavailable.');
    }
    if (!this.state.loadValid) {
      warnings.push('Suspension Load Cell (HX711) reading unavailable.');
    }

    let tempScore = 100;
    if (this.state.temperatureValid && this.state.temperature !== null) {
      const t = this.state.temperature;
      if (t >= this.settings.tempCritC) {
        tempScore = 30;
        warnings.push(`High ambient temperature: ${t.toFixed(1)}°C.`);
      } else if (t >= this.settings.tempWarnC) {
        tempScore = 65;
        warnings.push(`Elevated ambient temperature: ${t.toFixed(1)}°C.`);
      }
    } else {
      tempScore = 50;
    }

    let vibScore = 100;
    if (this.state.vibrationRaw !== null) {
      const v = this.state.vibrationRaw;
      if (v >= this.settings.vibrationCritRaw) {
        vibScore = 30;
        warnings.push(`Harsh vibration detected (ADC raw ${v}).`);
      } else if (v >= this.settings.vibrationWarnRaw) {
        vibScore = 70;
        warnings.push(`Elevated vibration (ADC raw ${v}).`);
      }
    } else {
      vibScore = 60;
    }

    let loadScore = 100;
    if (this.state.loadValid && this.state.loadKg !== null) {
      const l = this.state.loadKg;
      if (l >= this.settings.loadCritKg) {
        loadScore = 20;
        warnings.push(`Suspension load critical: ${l.toFixed(2)} kg near capacity limit!`);
      } else if (l >= this.settings.loadWarnKg) {
        loadScore = 65;
        warnings.push(`Suspension load high: ${l.toFixed(2)} kg.`);
      }
    } else {
      loadScore = 60;
    }

    const score = Math.round((tempScore * 0.35) + (vibScore * 0.35) + (loadScore * 0.30));
    this.state.healthScore = Math.max(0, Math.min(100, score));
    this.state.activeWarnings = warnings;

    if (validCount < 2) {
      this.state.healthStatus = 'INSUFFICIENT DATA';
      this.state.healthCondition = 'Partial telemetry (Probes offline)';
    } else if (
      (this.state.temperatureValid && this.state.temperature >= this.settings.tempCritC) ||
      (this.state.vibrationRaw !== null && this.state.vibrationRaw >= this.settings.vibrationCritRaw) ||
      (this.state.loadValid && this.state.loadKg >= this.settings.loadCritKg)
    ) {
      this.state.healthStatus = 'CRITICAL';
      this.state.healthCondition = 'Critical Threshold Limit Breach';
    } else if (
      (this.state.temperatureValid && this.state.temperature >= this.settings.tempWarnC) ||
      (this.state.vibrationRaw !== null && this.state.vibrationRaw >= this.settings.vibrationWarnRaw) ||
      (this.state.loadValid && this.state.loadKg >= this.settings.loadWarnKg) ||
      warnings.length > 0
    ) {
      this.state.healthStatus = 'WARNING';
      this.state.healthCondition = 'Attention Advised (Elevated Parameters)';
    } else {
      this.state.healthStatus = 'NORMAL';
      this.state.healthCondition = 'All Monitored Parameters Nominal';
    }
  }

  /**
   * Evaluates automatic alert thresholds and dispatches via EmailJS
   */
  evaluateAlerts() {
    if (typeof window.tyravexEmail === 'undefined') return;

    const snap = {
      device: 'TYRAVEX Prototype',
      temperature: this.state.temperature,
      humidity: this.state.humidity,
      pressure: this.state.tirePressureHpa,
      pressureDisplay: this.state.tirePressureDisplay,
      pressureUnit: this.settings.pressureUnit,
      vibrationRaw: this.state.vibrationRaw,
      loadKg: this.state.loadKg,
      healthScore: this.state.healthScore,
      healthStatus: this.state.healthStatus
    };

    if (this.state.temperatureValid && this.state.temperature >= this.settings.tempCritC) {
      window.tyravexEmail.triggerAlert(
        'temperature',
        'Ambient Temperature Critical Limit Exceeded',
        `Current temperature is ${this.state.temperature.toFixed(1)}°C (Limit: ${this.settings.tempCritC}°C).`,
        snap
      );
    }

    if (this.state.humidityValid && (this.state.humidity >= this.settings.humidityWarnHigh || this.state.humidity <= this.settings.humidityWarnLow)) {
      window.tyravexEmail.triggerAlert(
        'humidity',
        'Abnormal Ambient Humidity',
        `Current relative humidity is ${this.state.humidity.toFixed(1)}%RH.`,
        snap
      );
    }

    if (this.state.vibrationRaw !== null && this.state.vibrationRaw >= this.settings.vibrationCritRaw) {
      window.tyravexEmail.triggerAlert(
        'vibration',
        'Harsh Tire / Suspension Vibration',
        `Vibration ADC raw reached ${this.state.vibrationRaw} (Threshold: ${this.settings.vibrationCritRaw}).`,
        snap
      );
    }

    if (this.state.loadValid && this.state.loadKg !== null && this.state.loadKg >= this.settings.loadCritKg) {
      window.tyravexEmail.triggerAlert(
        'load',
        'Excessive Suspension / Tire Load',
        `Measured suspension load on tire is ${this.state.loadKg.toFixed(2)} kg (Capacity: 10 kg).`,
        snap
      );
    }
  }

  checkStaleData() {
    if (!this.state.lastPacketTime || !this.state.isConnected) return;

    const elapsedMs = Date.now() - this.state.lastPacketTime;
    const staleThresholdMs = (this.settings.staleTimeoutSeconds || 4) * 1000;

    if (elapsedMs > staleThresholdMs) {
      if (this.state.healthStatus !== 'INSUFFICIENT DATA') {
        this.state.healthStatus = 'INSUFFICIENT DATA';
        this.state.healthCondition = 'Telemetry Stale (Paused)';
        this.state.activeWarnings = [`No sensor packets received for > ${(elapsedMs / 1000).toFixed(0)}s`];
        this.notify();
      }
    }
  }

  appendChartData() {
    const timeLabel = new Date().toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });

    const maxPoints = Math.max(10, Math.min(200, this.settings.chartHistoryLength || 40));

    this.chartData.labels.push(timeLabel);
    this.chartData.temperature.push(this.state.temperatureValid ? this.state.temperature : null);
    this.chartData.humidity.push(this.state.humidityValid ? this.state.humidity : null);

    // Tire pressure converted to chosen unit
    const displayPress = this.state.pressureValid ? this.state.tirePressureDisplay : null;
    this.chartData.pressure.push(displayPress);

    this.chartData.vibration.push(this.state.vibrationRaw !== null ? this.state.vibrationNormalized : null);

    // Tire load in chosen unit
    const loadVal = this.state.loadValid
      ? (this.settings.loadDisplayUnit === 'N' ? this.state.loadN : this.state.loadKg)
      : null;
    this.chartData.load.push(loadVal);

    while (this.chartData.labels.length > maxPoints) {
      this.chartData.labels.shift();
      this.chartData.temperature.shift();
      this.chartData.humidity.shift();
      this.chartData.pressure.shift();
      this.chartData.vibration.shift();
      this.chartData.load.shift();
    }
  }

  resetChartHistory() {
    this.chartData = {
      labels: [],
      temperature: [],
      humidity: [],
      pressure: [],
      vibration: [],
      load: []
    };
    this.notify();
  }

  toggleChartPause() {
    this.isChartPaused = !this.isChartPaused;
    return this.isChartPaused;
  }

  addEventLog(severity, description) {
    const logItem = {
      id: Date.now() + Math.random().toString(36).substr(2, 4),
      timestamp: new Date().toLocaleTimeString('en-US', { hour12: false }),
      fullDate: new Date().toISOString(),
      temperature: this.state.temperature !== null ? `${this.state.temperature.toFixed(1)} °C` : '--',
      humidity: this.state.humidity !== null ? `${this.state.humidity.toFixed(1)} %RH` : '--',
      pressure: this.state.tirePressureDisplay !== null ? `${this.state.tirePressureDisplay} ${this.settings.pressureUnit}` : '--',
      vibration: this.state.vibrationRaw !== null ? `${this.state.vibrationRaw} ADC` : '--',
      load: this.state.loadKg !== null ? `${this.state.loadKg.toFixed(2)} kg` : '--',
      status: this.state.healthStatus,
      severity,
      description
    };

    this.eventLogs.unshift(logItem);
    if (this.eventLogs.length > 200) {
      this.eventLogs.pop();
    }

    this.notify();
  }

  exportLogsToCSV() {
    if (this.eventLogs.length === 0) {
      alert('No telemetry log events available to export.');
      return;
    }

    const headers = ['Timestamp', 'ISO Date', 'Severity', 'Estimated Status', 'Ambient Temp (°C)', 'Humidity (%RH)', 'Tire Pressure', 'Vibration Raw', 'Suspension Load (kg)', 'Description'];
    const rows = this.eventLogs.map((item) => [
      `"${item.timestamp}"`,
      `"${item.fullDate}"`,
      `"${item.severity}"`,
      `"${item.status}"`,
      `"${item.temperature}"`,
      `"${item.humidity}"`,
      `"${item.pressure}"`,
      `"${item.vibration}"`,
      `"${item.load}"`,
      `"${item.description.replace(/"/g, '""')}"`
    ]);

    const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);

    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `TYRAVEX_Telemetry_Log_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  setConnected(isConnected, portInfo = null) {
    this.state.isConnected = isConnected;
    this.state.portInfo = portInfo;
    if (isConnected) {
      this.addEventLog('INFO', `Hardware connected on ${portInfo?.usbProductId || 'USB Port'} @ ${portInfo?.baudRate || 115200} baud.`);
    } else {
      this.state.healthStatus = 'INSUFFICIENT DATA';
      this.state.healthCondition = 'Hardware Disconnected';
      this.addEventLog('WARNING', 'ESP32 Serial interface disconnected.');
    }
    this.notify();
  }

  startDemoMode() {
    if (this.demoInterval) return;
    this.state.isDemoMode = true;
    this.state.isConnected = true;
    this.state.portInfo = {
      usbVendorId: '0x303A',
      usbProductId: 'ESP32 Dev Prototype (Demo)',
      baudRate: 115200,
      openedAt: new Date().toISOString()
    };

    this.addEventLog('INFO', 'DEMO MODE activated (Simulated DHT11, Tire Pressure, Vibration, and HX711 streams).');

    let simTick = 0;
    let eventAccumulator = 0;
    this.demoInterval = setInterval(() => {
      simTick++;

      const simTemp = 29.0 + Math.sin(simTick / 10) * 2.5;
      const simHum = 52.0 + Math.cos(simTick / 12) * 6.0;

      // Tire pressure: baseline ~1013 hPa / 14.7 PSI with subtle driving variations
      const simPress = 1013.2 + Math.sin(simTick / 15) * 1.8;

      const isBump = (simTick % 8 === 0);
      const simVibRaw = isBump ? Math.floor(2500 + Math.random() * 700) : Math.floor(500 + Math.random() * 300);
      const simVibDigital = isBump ? 1 : 0;
      if (isBump) eventAccumulator++;

      // Suspension Load: baseline 24500 counts (0 kg) moving to 64000 - 100000 counts (1.8kg - 3.5kg)
      const simRawCounts = isBump
        ? Math.floor(75000 + Math.random() * 25000)
        : Math.floor(24500 + Math.sin(simTick / 5) * 12000 + (Math.sin(simTick / 14) * 8000));

      const simLoadKg = Number(Math.max(0, (simRawCounts - 24500) / 21500).toFixed(2));

      const demoPacket = {
        device: 'TYRAVEX-DEMO',
        temperature_c: Number(simTemp.toFixed(1)),
        humidity_percent: Number(simHum.toFixed(1)),
        tire_pressure_hpa: Number(simPress.toFixed(1)),
        atmospheric_pressure_hpa: Number(simPress.toFixed(1)),
        vibration_analog_raw: simVibRaw,
        vibration_digital: simVibDigital,
        vibration_event_count: eventAccumulator,
        load_kg: simLoadKg,
        load_raw: simRawCounts,
        load_calibrated: true,
        dht11_valid: true,
        bmp280_valid: true,
        vibration_analog_valid: true,
        vibration_digital_valid: true,
        hx711_valid: true,
        timestamp_ms: simTick * 1000
      };

      this.processPacket(demoPacket);
    }, 1000);

    this.notify();
  }

  stopDemoMode() {
    if (this.demoInterval) {
      clearInterval(this.demoInterval);
      this.demoInterval = null;
    }
    this.state.isDemoMode = false;
    this.state.isConnected = false;
    this.state.temperature = null;
    this.state.temperatureValid = false;
    this.state.humidity = null;
    this.state.humidityValid = false;
    this.state.tirePressureHpa = null;
    this.state.tirePressureDisplay = null;
    this.state.pressureValid = false;
    this.state.vibrationRaw = null;
    this.state.vibrationNormalized = null;
    this.state.loadKg = null;
    this.state.loadN = null;
    this.state.loadValid = false;
    this.state.healthStatus = 'INSUFFICIENT DATA';
    this.state.healthCondition = 'Awaiting Hardware Telemetry';
    this.addEventLog('INFO', 'DEMO MODE deactivated.');
    this.notify();
  }
}

// Export singleton instance to window
window.tyravexEngine = new TyravexDashboardEngine();
