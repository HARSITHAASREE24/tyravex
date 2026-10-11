/**
 * TYRAVEX Telemetry & Tyre Health Engine
 * Handles sensor validation, unit conversion, health estimation algorithms,
 * road impact profiling, event logging, CSV export, and chart datasets.
 */

class TyravexDashboardEngine {
  constructor() {
    this.storageKey = 'tyravex_user_settings';
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

      // Sensor readings
      temperature: null,
      temperatureValid: false,
      pressure: null, // in base unit (PSI)
      pressureValid: false,
      pressureUnit: 'PSI',
      vibration: null,
      vibrationValid: false,
      vibrationUnit: 'g',

      // Statistics
      tempMin: null,
      tempMax: null,
      recentTemps: [],
      peakVibration: 0,
      recentVibrations: [],
      impactEvents: 0,
      peakImpact: 0,
      abnormalVibrationCount: 0,

      // Computed health
      healthScore: null,
      healthStatus: 'INSUFFICIENT DATA', // GOOD, WARNING, CRITICAL, INSUFFICIENT DATA
      healthCondition: 'Awaiting Sensor Telemetry',
      healthTrend: 'STABLE',
      activeWarnings: [],

      // Road impact estimate
      roadCondition: 'INSUFFICIENT DATA' // SMOOTH, MODERATE, ROUGH, INSUFFICIENT DATA
    };

    // Live Chart Datasets (bounded history)
    this.isChartPaused = false;
    this.chartData = {
      labels: [],
      temperature: [],
      pressure: [],
      vibration: []
    };

    // Live Event Log (max 200 items in memory)
    this.eventLogs = [];
    this.activeLogFilter = 'ALL'; // ALL, WARNING, CRITICAL, SENSOR_ERROR

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
      targetPressure: 32.0, // in PSI
      pressureUnit: 'PSI', // PSI, bar, kPa
      pressureToleranceWarnPct: 10, // ±10% from target
      pressureToleranceCritPct: 20, // ±20% from target
      tempWarnC: 50.0, // °C
      tempCritC: 70.0, // °C
      vibrationWarnG: 1.5, // g
      vibrationCritG: 2.5, // g
      impactThresholdG: 2.0, // g spike for impact event
      weightPressure: 45, // %
      weightTemp: 30, // %
      weightVibration: 25, // %
      chartHistoryLength: 40, // data points
      staleTimeoutSeconds: 4, // seconds before marking data stale
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
    this.recomputeHealth();
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
   * Mathematically exact pressure unit conversions
   */
  static convertPressure(value, fromUnit, toUnit) {
    if (value === null || isNaN(value)) return null;
    if (fromUnit === toUnit) return value;

    // Convert input to PSI as reference
    let psiVal = value;
    if (fromUnit === 'bar') {
      psiVal = value * 14.50377377;
    } else if (fromUnit === 'kPa') {
      psiVal = value * 0.1450377377;
    }

    // Convert from PSI to target unit
    if (toUnit === 'bar') {
      return psiVal * 0.06894757;
    } else if (toUnit === 'kPa') {
      return psiVal * 6.894757;
    } else {
      return psiVal; // PSI
    }
  }

  /**
   * Ingest raw parsed packet from ESP32 or Demo generator
   * Matches specified JSON format:
   * {
   *   device: "TYRAVEX",
   *   temperature: 34.5,
   *   pressure: null,
   *   pressure_unit: "PSI",
   *   pressure_valid: false,
   *   vibration: 1.25,
   *   vibration_unit: "g",
   *   vibration_valid: true,
   *   temperature_valid: true,
   *   timestamp_ms: 12500
   * }
   */
  processPacket(packet) {
    if (!packet || typeof packet !== 'object') {
      this.state.invalidPacketCount++;
      return;
    }

    this.state.packetCount++;
    this.state.lastPacketTime = Date.now();

    // 1. Process Temperature (DS18B20)
    if (packet.temperature_valid === true && packet.temperature !== null && !isNaN(packet.temperature)) {
      const tempVal = Number(packet.temperature);
      // Realistic automotive tyre temp sanity range (-30°C to 130°C)
      if (tempVal >= -30 && tempVal <= 130) {
        this.state.temperature = tempVal;
        this.state.temperatureValid = true;

        if (this.state.tempMin === null || tempVal < this.state.tempMin) this.state.tempMin = tempVal;
        if (this.state.tempMax === null || tempVal > this.state.tempMax) this.state.tempMax = tempVal;

        this.state.recentTemps.push(tempVal);
        if (this.state.recentTemps.length > 10) this.state.recentTemps.shift();
      } else {
        this.state.temperatureValid = false;
        this.state.temperature = null;
        this.state.invalidPacketCount++;
      }
    } else {
      this.state.temperatureValid = false;
      this.state.temperature = null;
    }

    // 2. Process Pressure
    if (packet.pressure_valid === true && packet.pressure !== null && !isNaN(packet.pressure)) {
      const rawUnit = packet.pressure_unit || 'PSI';
      const rawVal = Number(packet.pressure);
      // Normalize incoming pressure to PSI
      const pressurePsi = TyravexDashboardEngine.convertPressure(rawVal, rawUnit, 'PSI');
      
      if (pressurePsi >= 0 && pressurePsi <= 120) {
        this.state.pressure = pressurePsi;
        this.state.pressureValid = true;
      } else {
        this.state.pressureValid = false;
        this.state.pressure = null;
        this.state.invalidPacketCount++;
      }
    } else {
      this.state.pressureValid = false;
      this.state.pressure = null;
    }

    // 3. Process Vibration
    if (packet.vibration_valid === true && packet.vibration !== null && !isNaN(packet.vibration)) {
      const vibVal = Number(packet.vibration);
      if (vibVal >= 0 && vibVal <= 25) {
        this.state.vibration = vibVal;
        this.state.vibrationValid = true;
        this.state.vibrationUnit = packet.vibration_unit || 'g';

        if (vibVal > this.state.peakVibration) {
          this.state.peakVibration = vibVal;
        }

        this.state.recentVibrations.push(vibVal);
        if (this.state.recentVibrations.length > 20) this.state.recentVibrations.shift();

        // Check for impact events (spikes > impact threshold)
        if (vibVal >= this.settings.impactThresholdG) {
          this.state.impactEvents++;
          if (vibVal > this.state.peakImpact) {
            this.state.peakImpact = vibVal;
          }
          this.addEventLog('WARNING', `Road impact detected (${vibVal.toFixed(2)} ${this.state.vibrationUnit})`);
        }

        // Track continuous harsh vibration
        if (vibVal >= this.settings.vibrationWarnG) {
          this.state.abnormalVibrationCount++;
        }
      } else {
        this.state.vibrationValid = false;
        this.state.vibration = null;
      }
    } else {
      this.state.vibrationValid = false;
      this.state.vibration = null;
    }

    // 4. Update Health and Road Condition Estimates
    this.recomputeHealth();
    this.recomputeRoadCondition();

    // 5. Append to Rolling Chart Datasets
    if (!this.isChartPaused) {
      this.appendChartData();
    }

    // 6. Check for automatic alert threshold triggers (EmailJS)
    this.evaluateAlerts();

    // 7. Dispatch updates to subscribers
    this.notify();
  }

  /**
   * Recompute Transparent Experimental Tyre Health Score (0-100%)
   * STRICT SAFETY CRITERION:
   * "Do not classify the tyre as healthy if essential readings are missing, stale, invalid or uncalibrated."
   */
  recomputeHealth() {
    const warnings = [];
    const validCount = (this.state.temperatureValid ? 1 : 0) +
                       (this.state.pressureValid ? 1 : 0) +
                       (this.state.vibrationValid ? 1 : 0);

    // If zero or insufficient sensors are valid, report INSUFFICIENT DATA
    if (validCount === 0 || !this.state.lastPacketTime) {
      this.state.healthScore = null;
      this.state.healthStatus = 'INSUFFICIENT DATA';
      this.state.healthCondition = 'No valid sensor telemetry received';
      this.state.activeWarnings = ['Connect ESP32 or activate sensor hardware.'];
      return;
    }

    // If pressure sensor is uncalibrated or disconnected
    if (!this.state.pressureValid) {
      warnings.push('Tyre pressure sensor uncalibrated or disconnected.');
    }

    // If temperature sensor is disconnected
    if (!this.state.temperatureValid) {
      warnings.push('Temperature sensor disconnected or invalid.');
    }

    // If vibration sensor is disconnected
    if (!this.state.vibrationValid) {
      warnings.push('Vibration telemetry uncalibrated or unavailable.');
    }

    // If critical sensors are missing, score cannot be considered healthy
    if (!this.state.pressureValid && !this.state.temperatureValid) {
      this.state.healthScore = null;
      this.state.healthStatus = 'INSUFFICIENT DATA';
      this.state.healthCondition = 'Essential primary sensors offline';
      this.state.activeWarnings = warnings;
      return;
    }

    // Component Scoring (100 is ideal, deducted for deviations)
    let pressureSubScore = 100;
    if (this.state.pressureValid && this.state.pressure !== null) {
      const target = this.settings.targetPressure;
      const deviation = Math.abs(this.state.pressure - target);
      const devPct = (deviation / target) * 100;

      if (devPct > this.settings.pressureToleranceCritPct) {
        pressureSubScore = Math.max(0, 100 - (devPct * 2.5));
        warnings.push(`Severe pressure deviation (${devPct.toFixed(1)}% off target ${target} PSI).`);
      } else if (devPct > this.settings.pressureToleranceWarnPct) {
        pressureSubScore = Math.max(40, 100 - (devPct * 2.0));
        warnings.push(`Moderate pressure deviation (${devPct.toFixed(1)}% off target).`);
      } else {
        pressureSubScore = 100 - (devPct * 0.5);
      }
    } else {
      // Pressure sensor missing: penalize heavily
      pressureSubScore = 30;
    }

    let tempSubScore = 100;
    if (this.state.temperatureValid && this.state.temperature !== null) {
      const temp = this.state.temperature;
      if (temp >= this.settings.tempCritC) {
        tempSubScore = Math.max(0, 40 - (temp - this.settings.tempCritC) * 3);
        warnings.push(`Critical tyre temperature (${temp.toFixed(1)}°C >= ${this.settings.tempCritC}°C).`);
      } else if (temp >= this.settings.tempWarnC) {
        tempSubScore = Math.max(50, 85 - (temp - this.settings.tempWarnC) * 2);
        warnings.push(`Elevated tyre temperature (${temp.toFixed(1)}°C >= ${this.settings.tempWarnC}°C).`);
      } else {
        tempSubScore = 100;
      }
    } else {
      tempSubScore = 40;
    }

    let vibSubScore = 100;
    if (this.state.vibrationValid && this.state.vibration !== null) {
      const vib = this.state.vibration;
      if (vib >= this.settings.vibrationCritG) {
        vibSubScore = Math.max(10, 45 - (vib - this.settings.vibrationCritG) * 15);
        warnings.push(`High vibration intensity (${vib.toFixed(2)}g exceeds critical threshold).`);
      } else if (vib >= this.settings.vibrationWarnG) {
        vibSubScore = Math.max(50, 80 - (vib - this.settings.vibrationWarnG) * 25);
        warnings.push(`Elevated vibration level (${vib.toFixed(2)}g).`);
      } else {
        vibSubScore = 100;
      }
    } else {
      vibSubScore = 60;
    }

    // Weighted aggregation
    const totalWeight = this.settings.weightPressure + this.settings.weightTemp + this.settings.weightVibration;
    const wPress = this.settings.weightPressure / totalWeight;
    const wTemp = this.settings.weightTemp / totalWeight;
    const wVib = this.settings.weightVibration / totalWeight;

    const weightedScore = Math.round(
      (pressureSubScore * wPress) +
      (tempSubScore * wTemp) +
      (vibSubScore * wVib)
    );

    this.state.healthScore = Math.max(0, Math.min(100, weightedScore));
    this.state.activeWarnings = warnings;

    // Safety Override: If pressure or temperature is missing, status CANNOT be GOOD
    if (!this.state.pressureValid || !this.state.temperatureValid) {
      this.state.healthStatus = 'WARNING';
      this.state.healthCondition = 'Partial telemetry (Uncalibrated or Missing Sensors)';
      return;
    }

    // Classification based on score and safety thresholds
    if (this.state.healthScore >= 80 && warnings.length === 0) {
      this.state.healthStatus = 'GOOD';
      this.state.healthCondition = 'Optimal Operating Range';
    } else if (this.state.healthScore >= 60 || (warnings.length > 0 && this.state.healthScore >= 50)) {
      this.state.healthStatus = 'WARNING';
      this.state.healthCondition = 'Attention Advised (Parameters Out of Optimal Range)';
    } else {
      this.state.healthStatus = 'CRITICAL';
      this.state.healthCondition = 'Immediate Inspection Recommended';
    }

    // Health Trend based on recent samples
    if (this.state.recentTemps.length >= 3) {
      const recent = this.state.recentTemps;
      const delta = recent[recent.length - 1] - recent[0];
      if (delta > 2.0) this.state.healthTrend = 'DEGRADING';
      else if (delta < -2.0) this.state.healthTrend = 'IMPROVING';
      else this.state.healthTrend = 'STABLE';
    }
  }

  /**
   * Recompute Road Condition based on recent vibration samples
   */
  recomputeRoadCondition() {
    if (!this.state.vibrationValid || this.state.recentVibrations.length < 5) {
      this.state.roadCondition = 'INSUFFICIENT DATA';
      return;
    }

    const sum = this.state.recentVibrations.reduce((a, b) => a + b, 0);
    const avg = sum / this.state.recentVibrations.length;

    if (avg < 0.6) {
      this.state.roadCondition = 'SMOOTH';
    } else if (avg < 1.4) {
      this.state.roadCondition = 'MODERATE';
    } else {
      this.state.roadCondition = 'ROUGH';
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
      pressure: this.state.pressure,
      pressureUnit: this.settings.pressureUnit,
      vibration: this.state.vibration,
      vibrationUnit: this.state.vibrationUnit,
      healthScore: this.state.healthScore,
      healthStatus: this.state.healthStatus
    };

    // 1. Critical tyre condition alert
    if (this.state.healthStatus === 'CRITICAL') {
      window.tyravexEmail.triggerAlert(
        'critical_health',
        'CRITICAL Tyre Condition Detected',
        `Estimated tyre health score dropped to ${this.state.healthScore}%. Active issues: ${this.state.activeWarnings.join('; ')}`,
        snap
      );
    }

    // 2. High temperature alert
    if (this.state.temperatureValid && this.state.temperature >= this.settings.tempCritC) {
      window.tyravexEmail.triggerAlert(
        'temperature',
        'Tyre Temperature Exceeded Critical Limit',
        `Current tyre temperature is ${this.state.temperature.toFixed(1)}°C (Limit: ${this.settings.tempCritC}°C).`,
        snap
      );
    }

    // 3. Pressure deviation alert
    if (this.state.pressureValid && this.state.pressure !== null) {
      const devPct = Math.abs(this.state.pressure - this.settings.targetPressure) / this.settings.targetPressure * 100;
      if (devPct >= this.settings.pressureToleranceCritPct) {
        window.tyravexEmail.triggerAlert(
          'pressure',
          'Tyre Pressure Outside Safety Tolerance',
          `Current pressure is ${this.state.pressure.toFixed(1)} PSI (Target: ${this.settings.targetPressure} PSI, Deviation: ${devPct.toFixed(1)}%).`,
          snap
        );
      }
    }

    // 4. Abnormal vibration alert
    if (this.state.vibrationValid && this.state.vibration >= this.settings.vibrationCritG) {
      window.tyravexEmail.triggerAlert(
        'vibration',
        'Abnormal Tyre Vibration Detected',
        `Current vibration reached ${this.state.vibration.toFixed(2)}g (Threshold: ${this.settings.vibrationCritG}g).`,
        snap
      );
    }
  }

  /**
   * Check for stale incoming data (no packet received in staleTimeoutSeconds)
   */
  checkStaleData() {
    if (!this.state.lastPacketTime || !this.state.isConnected) return;

    const elapsedMs = Date.now() - this.state.lastPacketTime;
    const staleThresholdMs = (this.settings.staleTimeoutSeconds || 4) * 1000;

    if (elapsedMs > staleThresholdMs) {
      if (this.state.healthStatus !== 'INSUFFICIENT DATA') {
        this.state.healthStatus = 'INSUFFICIENT DATA';
        this.state.healthCondition = 'Telemetry Stale (Communication Paused)';
        this.state.activeWarnings = ['No fresh sensor packets received for > ' + (elapsedMs / 1000).toFixed(0) + 's'];
        this.notify();
      }
    }
  }

  /**
   * Appends live reading to rolling chart history
   */
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
    
    // Convert pressure to currently displayed user unit
    let convertedPressure = null;
    if (this.state.pressureValid && this.state.pressure !== null) {
      convertedPressure = Number(
        TyravexDashboardEngine.convertPressure(this.state.pressure, 'PSI', this.settings.pressureUnit).toFixed(2)
      );
    }
    this.chartData.pressure.push(convertedPressure);
    this.chartData.vibration.push(this.state.vibrationValid ? this.state.vibration : null);

    // Limit buffer length
    while (this.chartData.labels.length > maxPoints) {
      this.chartData.labels.shift();
      this.chartData.temperature.shift();
      this.chartData.pressure.shift();
      this.chartData.vibration.shift();
    }
  }

  /**
   * Clears chart history
   */
  resetChartHistory() {
    this.chartData = {
      labels: [],
      temperature: [],
      pressure: [],
      vibration: []
    };
    this.notify();
  }

  toggleChartPause() {
    this.isChartPaused = !this.isChartPaused;
    return this.isChartPaused;
  }

  /**
   * Add a log entry to the live event log
   */
  addEventLog(severity, description) {
    const logItem = {
      id: Date.now() + Math.random().toString(36).substr(2, 4),
      timestamp: new Date().toLocaleTimeString('en-US', { hour12: false }),
      fullDate: new Date().toISOString(),
      temperature: this.state.temperature !== null ? `${this.state.temperature.toFixed(1)} °C` : '--',
      pressure: this.state.pressure !== null
        ? `${TyravexDashboardEngine.convertPressure(this.state.pressure, 'PSI', this.settings.pressureUnit).toFixed(1)} ${this.settings.pressureUnit}`
        : '--',
      vibration: this.state.vibration !== null ? `${this.state.vibration.toFixed(2)} ${this.state.vibrationUnit}` : '--',
      status: this.state.healthStatus,
      severity, // 'INFO', 'WARNING', 'CRITICAL', 'SENSOR_ERROR'
      description
    };

    this.eventLogs.unshift(logItem);
    if (this.eventLogs.length > 200) {
      this.eventLogs.pop();
    }

    this.notify();
  }

  /**
   * Export in-memory event logs as standard CSV file
   */
  exportLogsToCSV() {
    if (this.eventLogs.length === 0) {
      alert('No telemetry log events available to export.');
      return;
    }

    const headers = ['Timestamp', 'ISO Date', 'Severity', 'Estimated Status', 'Temperature', 'Pressure', 'Vibration', 'Description'];
    const rows = this.eventLogs.map((item) => [
      `"${item.timestamp}"`,
      `"${item.fullDate}"`,
      `"${item.severity}"`,
      `"${item.status}"`,
      `"${item.temperature}"`,
      `"${item.pressure}"`,
      `"${item.vibration}"`,
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

  /**
   * Set Connection Status
   */
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

  /**
   * Simulated Demo Mode Generator
   * STRICT LABELING: "DEMO MODE"
   * Provides realistic demonstration data when physical hardware is not yet attached.
   */
  startDemoMode() {
    if (this.demoInterval) return;
    this.state.isDemoMode = true;
    this.state.isConnected = true;
    this.state.portInfo = {
      usbVendorId: '0x303A',
      usbProductId: 'ESP32 Simulated Prototype',
      baudRate: 115200,
      openedAt: new Date().toISOString()
    };

    this.addEventLog('INFO', 'DEMO MODE initialized with synthetic tyre physics telemetry.');

    let simTick = 0;
    this.demoInterval = setInterval(() => {
      simTick++;
      // Subtle variations simulating tyre temperature warmup and road bumps
      const baseTemp = 32.5 + Math.sin(simTick / 15) * 4.2;
      const basePress = 31.8 + Math.cos(simTick / 20) * 1.1;
      
      // Occasional road bump / impact event
      const isBump = (simTick % 12 === 0);
      const vibration = isBump ? (2.1 + Math.random() * 0.8) : (0.25 + Math.random() * 0.45);

      const demoPacket = {
        device: 'TYRAVEX-DEMO',
        temperature: Number(baseTemp.toFixed(1)),
        temperature_valid: true,
        pressure: Number(basePress.toFixed(1)),
        pressure_unit: 'PSI',
        pressure_valid: true,
        vibration: Number(vibration.toFixed(2)),
        vibration_unit: 'g',
        vibration_valid: true,
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
    this.state.pressure = null;
    this.state.pressureValid = false;
    this.state.vibration = null;
    this.state.vibrationValid = false;
    this.state.healthStatus = 'INSUFFICIENT DATA';
    this.state.healthCondition = 'Awaiting Sensor Telemetry';
    this.addEventLog('INFO', 'DEMO MODE deactivated.');
    this.notify();
  }
}

// Export singleton instance to window
window.tyravexEngine = new TyravexDashboardEngine();
