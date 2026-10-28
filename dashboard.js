/**
 * TYRAVEX Telemetry & Monitoring Engine
 * Telemetry processor for:
 * 1. DHT11: Ambient Temperature (°C) & Humidity (%RH)
 * 2. BMP280: Tire / Atmospheric Pressure (PSI / bar / kPa / hPa)
 * 3. Vibration Sensor: Analog Activity Deviation (GPIO 35 ADC)
 * 4. HX711 Load Cell: Suspension / Tire Applied Weight (kg / N / Raw counts)
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
      temperatureUnit: 'C',
      temperatureValid: false,
      tempMin: null,
      tempMax: null,
      recentTemps: [],
      tempTrend: 'STABLE',
      humidity: null,             // %RH
      humidityUnit: '%',
      humidityValid: false,
      humidityStatus: 'NO DATA',
      dht11Valid: false,

      // 2. Tire / Atmospheric Pressure (BMP280)
      tirePressureHpa: null,      // Base reading in hPa
      tirePressureDisplay: null,  // In user's chosen unit (PSI / bar / kPa / hPa)
      pressureUnit: 'hPa',
      pressureValid: false,
      recentPressures: [],
      pressureTrend: 'STEADY',
      bmp280Valid: false,

      // 3. Vibration Sensor (Analog Activity Deviation)
      vibration: null,            // ADC deviation activity (e.g. 3.42)
      vibrationRaw: null,         // Deviation count or raw value
      vibrationUnit: 'ADC_deviation',
      vibrationNormalized: null,  // 0 - 100%
      vibrationDigital: 0,        // 0 (quiet) or 1 (trigger)
      vibrationDigitalStatus: 'QUIET',
      vibrationEventCount: 0,
      peakVibration: 0,
      peakVibrationRaw: 0,
      recentVibrations: [],
      vibrationStatus: 'AWAITING',
      vibrationValid: false,
      vibrationAnalogValid: false,
      vibrationDigitalValid: false,

      // 4. HX711 & 10 kg Load Cell (Suspension Load on Tire)
      loadKg: null,
      loadPercent: null,
      loadN: null,
      loadUnit: 'kg',
      loadRaw: null,
      loadCalibrated: false,
      loadValid: false,
      hx711Connected: false,
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

      // Vibration Sensor Limits (ADC deviation activity)
      vibrationWarnDev: 15.0,
      vibrationCritDev: 40.0,
      vibrationWarnRaw: 1800,
      vibrationCritRaw: 3000,

      // Suspension Load on Tire (10 kg max rated load cell)
      loadWarnKg: 7.5,
      loadCritKg: 9.5,
      loadRatedCapacityKg: 10.0,
      loadDisplayUnit: 'kg', // 'kg', '%', or 'N'
      loadTareOffset: 0,
      loadScaleFactor: 12345.0, // Matches sketch default CALIBRATION_FACTOR = 12345.0f
      webCalibrated: false,

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
    const tempValid = packet.temperature_valid !== undefined
      ? Boolean(packet.temperature_valid)
      : Boolean(packet.dht11_valid);
    this.state.dht11Valid = tempValid;
    this.state.temperatureValid = tempValid;

    const rawTemp = packet.temperature !== undefined ? packet.temperature : packet.temperature_c;
    if (tempValid && rawTemp !== null && !isNaN(rawTemp)) {
      const tempVal = Number(rawTemp);
      if (tempVal >= -40 && tempVal <= 85) {
        this.state.temperature = Number(tempVal.toFixed(1));
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

    const humValid = packet.humidity_valid !== undefined
      ? Boolean(packet.humidity_valid)
      : Boolean(packet.dht11_valid);
    this.state.humidityValid = humValid;

    const rawHum = packet.humidity !== undefined ? packet.humidity : packet.humidity_percent;
    if (humValid && rawHum !== null && !isNaN(rawHum)) {
      const humVal = Number(rawHum);
      if (humVal >= 0 && humVal <= 100) {
        this.state.humidity = Number(humVal.toFixed(1));
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

    // 2. Process Tyre Pressure (BMP280)
    const pressValid = packet.pressure_valid !== undefined
      ? Boolean(packet.pressure_valid)
      : Boolean(packet.bmp280_valid);
    this.state.bmp280Valid = pressValid;
    this.state.pressureValid = pressValid;

    const rawHpa = packet.pressure !== undefined
      ? packet.pressure
      : (packet.tyre_pressure_hpa !== undefined
          ? packet.tyre_pressure_hpa
          : (packet.tire_pressure_hpa !== undefined
              ? packet.tire_pressure_hpa
              : packet.atmospheric_pressure_hpa));

    if (pressValid && rawHpa !== null && !isNaN(rawHpa)) {
      const pressVal = Number(rawHpa);
      if (pressVal >= 300 && pressVal <= 1400) {
        this.state.tirePressureHpa = Number(pressVal.toFixed(2));
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

    // 3. Process Vibration Sensor (Analog Activity Deviation)
    const vibValid = packet.vibration_valid !== undefined
      ? Boolean(packet.vibration_valid)
      : Boolean(packet.vibration_analog_valid);
    this.state.vibrationValid = vibValid;
    this.state.vibrationAnalogValid = vibValid;
    this.state.vibrationDigitalValid = Boolean(packet.vibration_digital_valid);

    const rawVib = packet.vibration !== undefined
      ? packet.vibration
      : packet.vibration_analog_raw;

    if (vibValid && rawVib !== null && !isNaN(rawVib)) {
      const vibVal = Math.max(0, Number(rawVib));
      this.state.vibration = Number(vibVal.toFixed(2));
      this.state.vibrationRaw = Number(vibVal.toFixed(2));
      this.state.vibrationUnit = packet.vibration_unit || (vibVal <= 500 ? 'ADC_deviation' : 'ADC_raw');

      // Normalized 0 - 100% calculation
      if (this.state.vibrationUnit === 'ADC_deviation' || vibVal <= 500) {
        // Deviation mode: ~0-5 quiet, 15 elevated, 40+ harsh
        this.state.vibrationNormalized = Math.min(100, Math.round((vibVal / 50) * 100));
        if (vibVal >= (this.settings.vibrationCritDev || 40)) {
          this.state.vibrationStatus = 'CRITICAL VIBRATION';
        } else if (vibVal >= (this.settings.vibrationWarnDev || 15)) {
          this.state.vibrationStatus = 'ELEVATED';
        } else {
          this.state.vibrationStatus = 'NOMINAL';
        }
        this.state.vibrationDigital = vibVal >= 15 ? 1 : 0;
        this.state.vibrationDigitalStatus = vibVal >= 15 ? 'ACTIVE (PULSE)' : 'QUIET';
      } else {
        // Legacy 12-bit ADC raw mode (0-4095)
        this.state.vibrationNormalized = Math.min(100, Math.round((vibVal / 4095) * 100));
        if (vibVal >= this.settings.vibrationCritRaw) {
          this.state.vibrationStatus = 'CRITICAL VIBRATION';
        } else if (vibVal >= this.settings.vibrationWarnRaw) {
          this.state.vibrationStatus = 'ELEVATED';
        } else {
          this.state.vibrationStatus = 'NOMINAL';
        }
        this.state.vibrationDigital = packet.vibration_digital ? 1 : 0;
        this.state.vibrationDigitalStatus = this.state.vibrationDigital === 1 ? 'ACTIVE (PULSE)' : 'QUIET';
      }

      if (vibVal > this.state.peakVibration) {
        this.state.peakVibration = Number(vibVal.toFixed(2));
        this.state.peakVibrationRaw = Number(vibVal.toFixed(2));
      }

      this.state.recentVibrations.push(vibVal);
      if (this.state.recentVibrations.length > 20) this.state.recentVibrations.shift();
    } else {
      this.state.vibration = null;
      this.state.vibrationRaw = null;
      this.state.vibrationNormalized = null;
      this.state.vibrationStatus = 'NO DATA';
      this.state.vibrationDigital = 0;
      this.state.vibrationDigitalStatus = 'NO DATA';
    }

    if (packet.vibration_event_count !== undefined) {
      this.state.vibrationEventCount = Number(packet.vibration_event_count) || 0;
    }

    // 4. Process HX711 Load Cell / Suspension Weight (kg and %)
    const hxConnected = packet.hx711_connected !== undefined
      ? Boolean(packet.hx711_connected)
      : Boolean(packet.hx711_valid);
    this.state.hx711Connected = hxConnected;
    this.state.hx711Valid = hxConnected;

    const rawLoad = packet.loadcell_raw !== undefined
      ? packet.loadcell_raw
      : packet.load_raw;
    if (rawLoad !== undefined && rawLoad !== null && !isNaN(rawLoad)) {
      this.state.loadRaw = Number(rawLoad);
    }

    let calculatedKg = null;
    let calculatedPercent = null;
    let isCalibrated = false;

    // Check if firmware provided calibrated weight
    const rawWeight = packet.weight !== undefined ? packet.weight : packet.load_kg;
    const isWeightValid = packet.weight_valid !== undefined
      ? Boolean(packet.weight_valid)
      : Boolean(packet.load_calibrated);

    if (isWeightValid && rawWeight !== null && !isNaN(rawWeight)) {
      calculatedKg = Number(rawWeight);
      if (packet.weight_percent !== undefined && packet.weight_percent !== null && !isNaN(packet.weight_percent)) {
        calculatedPercent = Number(packet.weight_percent);
      } else {
        calculatedPercent = (calculatedKg / (this.settings.loadRatedCapacityKg || 10.0)) * 100;
      }
      isCalibrated = true;
      this.state.loadStatus = 'CALIBRATED (ESP32)';
    } else if (hxConnected && this.state.loadRaw !== null) {
      // Auto-tare and convert raw data to digital kg & percentage
      if (this.settings.loadTareOffset === undefined || this.settings.loadTareOffset === 0) {
        this.settings.loadTareOffset = this.state.loadRaw;
        this.saveSettings({ loadTareOffset: this.state.loadRaw });
      }
      const tare = this.settings.loadTareOffset || 0;
      const factor = this.settings.loadScaleFactor || 12345.0;
      if (factor > 0) {
        calculatedKg = Math.max(0, (this.state.loadRaw - tare) / factor);
        calculatedPercent = (calculatedKg / (this.settings.loadRatedCapacityKg || 10.0)) * 100;
        isCalibrated = true;
        this.state.loadStatus = 'DIGITAL ACTIVE';
      }
    }

    this.state.loadCalibrated = isCalibrated;

    if (hxConnected && calculatedKg !== null && !isNaN(calculatedKg)) {
      const loadKgVal = Math.max(0, calculatedKg);
      this.state.loadKg = Number(loadKgVal.toFixed(2));
      this.state.loadPercent = Math.min(100, Math.max(0, Number((calculatedPercent !== null ? calculatedPercent : (loadKgVal / 10.0) * 100).toFixed(1))));
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
      }
    } else {
      this.state.loadKg = null;
      this.state.loadPercent = null;
      this.state.loadN = null;
      this.state.loadValid = false;
      this.state.loadStatus = hxConnected ? 'UNCALIBRATED' : (this.state.isConnected ? 'AMPLIFIER FAULT' : 'NO DATA');
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
   * Browser-side zeroing (Tare) of the load cell
   */
  tareLoadCell() {
    const currentRaw = this.state.loadRaw !== null ? this.state.loadRaw : 0;
    this.saveSettings({
      loadTareOffset: currentRaw
    });
    this.state.loadKg = 0.00;
    this.state.loadN = 0.00;
    this.state.loadValid = true;
    this.addEventLog('INFO', `Load cell tared. Zero baseline offset saved at ${currentRaw.toLocaleString()} counts.`);
    this.notify();
    return currentRaw;
  }

  /**
   * Browser-side scale calibration with reference weight
   */
  calibrateLoadCell(knownWeightKg) {
    const currentRaw = this.state.loadRaw !== null ? this.state.loadRaw : 0;
    const tare = this.settings.loadTareOffset || 0;
    const delta = Math.abs(currentRaw - tare);
    if (delta <= 10 || knownWeightKg <= 0) {
      throw new Error('Sensor delta too small for calibration. Ensure reference weight is firmly on load cell.');
    }
    const factor = Number((delta / knownWeightKg).toFixed(1));
    this.saveSettings({
      loadScaleFactor: factor,
      webCalibrated: true
    });
    this.state.loadKg = Number(knownWeightKg.toFixed(2));
    this.state.loadN = Number((knownWeightKg * 9.80665).toFixed(2));
    this.state.loadValid = true;
    this.state.loadCalibrated = true;
    this.state.loadStatus = 'CALIBRATED (WEB)';
    this.addEventLog('INFO', `Load cell calibrated with ${knownWeightKg} kg. Scale factor: ${factor.toLocaleString()} counts/kg.`);
    this.notify();
    return factor;
  }

  /**
   * Recompute Overall Monitoring Status
   */
  recomputeMonitoringStatus() {
    const warnings = [];
    const validCount = (this.state.temperatureValid ? 1 : 0) +
                       (this.state.pressureValid ? 1 : 0) +
                       (this.state.vibrationValid ? 1 : 0) +
                       ((this.state.loadValid || this.state.hx711Connected) ? 1 : 0);

    if (!this.state.lastPacketTime || validCount === 0) {
      this.state.healthScore = null;
      this.state.healthStatus = 'INSUFFICIENT DATA';
      this.state.healthCondition = 'Awaiting Telemetry Stream';
      this.state.activeWarnings = ['Connect ESP32 or activate Demo Mode.'];
      return;
    }

    if (!this.state.temperatureValid) {
      warnings.push('DHT11 Temperature & Humidity sensor offline.');
    }
    if (!this.state.pressureValid) {
      warnings.push('Tyre Pressure sensor (BMP280) offline.');
    }
    if (!this.state.vibrationValid) {
      warnings.push('Vibration sensor module reading unavailable.');
    }
    if (!this.state.loadValid && !this.state.hx711Connected) {
      warnings.push('Suspension Load Cell (HX711) disconnected or wiring error.');
    } else if (this.state.hx711Connected && !this.state.loadCalibrated) {
      warnings.push('Suspension Load Cell (HX711) streaming raw counts (Calibration Recommended).');
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
    if (this.state.vibrationValid && this.state.vibration !== null) {
      const v = this.state.vibration;
      const isDev = this.state.vibrationUnit === 'ADC_deviation' || v <= 500;
      const crit = isDev ? (this.settings.vibrationCritDev || 40) : this.settings.vibrationCritRaw;
      const warn = isDev ? (this.settings.vibrationWarnDev || 15) : this.settings.vibrationWarnRaw;

      if (v >= crit) {
        vibScore = 30;
        warnings.push(`Harsh vibration detected (${v.toFixed(1)} ${this.state.vibrationUnit}).`);
      } else if (v >= warn) {
        vibScore = 70;
        warnings.push(`Elevated vibration (${v.toFixed(1)} ${this.state.vibrationUnit}).`);
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
    } else if (this.state.hx711Connected) {
      loadScore = 80;
    } else {
      loadScore = 60;
    }

    const score = Math.round((tempScore * 0.35) + (vibScore * 0.35) + (loadScore * 0.30));
    this.state.healthScore = Math.max(0, Math.min(100, score));
    this.state.activeWarnings = warnings;

    const isVibCrit = this.state.vibrationValid && this.state.vibration !== null &&
      (this.state.vibration >= (this.state.vibrationUnit === 'ADC_deviation' || this.state.vibration <= 500 ? (this.settings.vibrationCritDev || 40) : this.settings.vibrationCritRaw));
    const isVibWarn = this.state.vibrationValid && this.state.vibration !== null &&
      (this.state.vibration >= (this.state.vibrationUnit === 'ADC_deviation' || this.state.vibration <= 500 ? (this.settings.vibrationWarnDev || 15) : this.settings.vibrationWarnRaw));

    if (validCount < 2) {
      this.state.healthStatus = 'INSUFFICIENT DATA';
      this.state.healthCondition = 'Partial telemetry (Probes offline)';
    } else if (
      (this.state.temperatureValid && this.state.temperature >= this.settings.tempCritC) ||
      isVibCrit ||
      (this.state.loadValid && this.state.loadKg >= this.settings.loadCritKg)
    ) {
      this.state.healthStatus = 'CRITICAL';
      this.state.healthCondition = 'Critical Threshold Limit Breach';
    } else if (
      (this.state.temperatureValid && this.state.temperature >= this.settings.tempWarnC) ||
      isVibWarn ||
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
      vibrationRaw: this.state.vibration,
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

    const isVibCrit = this.state.vibrationValid && this.state.vibration !== null &&
      (this.state.vibration >= (this.state.vibrationUnit === 'ADC_deviation' || this.state.vibration <= 500 ? (this.settings.vibrationCritDev || 40) : this.settings.vibrationCritRaw));

    if (isVibCrit) {
      window.tyravexEmail.triggerAlert(
        'vibration',
        'Harsh Tyre / Suspension Vibration',
        `Vibration activity reached ${this.state.vibration.toFixed(1)} ${this.state.vibrationUnit}.`,
        snap
      );
    }

    if (this.state.loadValid && this.state.loadKg !== null && this.state.loadKg >= this.settings.loadCritKg) {
      window.tyravexEmail.triggerAlert(
        'load',
        'Excessive Suspension / Tyre Load',
        `Measured suspension load on tyre is ${this.state.loadKg.toFixed(2)} kg (Capacity: 10 kg).`,
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

    // Vibration activity / normalized intensity
    this.chartData.vibration.push(this.state.vibrationValid ? this.state.vibrationNormalized : null);

    // Tire load in chosen unit (kg, %, or N)
    let loadVal = null;
    if (this.state.loadValid) {
      if (this.settings.loadDisplayUnit === '%') {
        loadVal = this.state.loadPercent;
      } else if (this.settings.loadDisplayUnit === 'N') {
        loadVal = this.state.loadN;
      } else {
        loadVal = this.state.loadKg;
      }
    }
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
      vibration: this.state.vibration !== null ? `${this.state.vibration.toFixed(1)} dev` : '--',
      load: this.state.loadKg !== null ? `${this.state.loadKg.toFixed(2)} kg` : (this.state.loadRaw !== null ? `${this.state.loadRaw} counts` : '--'),
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

    const headers = ['Timestamp', 'ISO Date', 'Severity', 'Estimated Status', 'Ambient Temp (°C)', 'Humidity (%RH)', 'Tyre Pressure', 'Vibration Activity', 'Suspension Load (kg)', 'Description'];
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

    this.addEventLog('INFO', 'DEMO MODE activated (Simulated DHT11, BMP280, Vibration ADC, and HX711 streams).');

    let simTick = 0;
    this.demoInterval = setInterval(() => {
      simTick++;

      const simTemp = 28.5 + Math.sin(simTick / 10) * 2.2;
      const simHum = 54.0 + Math.cos(simTick / 12) * 5.0;

      // Atmospheric/Tire pressure: baseline ~1013.25 hPa
      const simPress = 1013.25 + Math.sin(simTick / 15) * 1.5;

      // Vibration Activity: baseline ~2.5 ADC deviation; occasional spike ~25-45
      const isBump = (simTick % 8 === 0);
      const simVibDev = isBump ? Number((28.0 + Math.random() * 22.0).toFixed(2)) : Number((1.8 + Math.random() * 3.2).toFixed(2));

      // Suspension Load: baseline ~128,450 counts (approx zero load), bumping to 155,000 counts (~2.15 kg)
      const baselineOffset = this.settings.loadTareOffset || 128450;
      const factor = this.settings.loadScaleFactor || 12345.0;
      const simRawCounts = isBump
        ? Math.floor(baselineOffset + factor * (1.8 + Math.random() * 1.5))
        : Math.floor(baselineOffset + factor * (0.05 + Math.sin(simTick / 6) * 0.05));

      const simLoadKg = Number(Math.max(0, (simRawCounts - baselineOffset) / factor).toFixed(2));

      const demoPacket = {
        device: 'TYRAVEX',
        temperature: Number(simTemp.toFixed(1)),
        temperature_unit: 'C',
        temperature_valid: true,
        humidity: Number(simHum.toFixed(1)),
        humidity_unit: '%',
        humidity_valid: true,
        pressure: Number(simPress.toFixed(2)),
        pressure_unit: 'hPa',
        pressure_valid: true,
        vibration: simVibDev,
        vibration_unit: 'ADC_deviation',
        vibration_valid: true,
        weight: simLoadKg,
        weight_unit: 'kg',
        weight_valid: true,
        loadcell_raw: simRawCounts,
        hx711_connected: true,
        timestamp_ms: simTick * 1000,
        // Legacy fallbacks
        temperature_c: Number(simTemp.toFixed(1)),
        humidity_percent: Number(simHum.toFixed(1)),
        tyre_pressure_hpa: Number(simPress.toFixed(2)),
        load_kg: simLoadKg,
        load_raw: simRawCounts,
        load_calibrated: true,
        dht11_valid: true,
        bmp280_valid: true,
        vibration_analog_valid: true,
        hx711_valid: true
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
    this.state.vibration = null;
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
