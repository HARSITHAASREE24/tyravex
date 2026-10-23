/**
 * TYRAVEX Email Alert Service (Revised Hardware Edition)
 * Integrates EmailJS browser SDK with rate limiting, cooldown tracking,
 * and customizable notification triggers for:
 * - High ambient temperature (DHT11)
 * - Configurable humidity warning (DHT11)
 * - Abnormal vibration intensity (Vibration Module)
 * - Excessive suspension load (HX711 10 kg load cell)
 * - Sensor failure / disconnection
 *
 * NOTE: Does NOT alert on BMP280 atmospheric pressure as tyre pressure.
 * No hardcoded private credentials.
 */

class TyravexEmailAlertService {
  constructor() {
    this.storageKey = 'tyravex_email_settings_v2';
    this.settings = this.loadSettings();

    // Timestamp tracking for rate limiting (cooldown in ms)
    this.lastSentTimes = {
      temperature: 0,
      humidity: 0,
      vibration: 0,
      load: 0,
      critical_health: 0,
      sensor_fault: 0,
      test: 0
    };

    this.defaultCooldownMs = 90 * 1000; // 90 seconds default cooldown per category
    this.isSending = false;
    this.lastDeliveryStatus = {
      status: 'IDLE', // 'IDLE', 'SENDING', 'SUCCESS', 'FAILED', 'UNCONFIGURED'
      message: 'Email alert service idle.',
      timestamp: null
    };

    this.onStatusChange = null;

    // Initialize EmailJS if credentials exist in localStorage
    this.initEmailJS();
  }

  /**
   * Default configuration options
   */
  getDefaultSettings() {
    return {
      enabled: false,
      publicKey: '',
      serviceId: '',
      templateId: '',
      recipientEmail: '',
      alertOnTemperature: true,
      alertOnHumidity: true,
      alertOnVibration: true,
      alertOnLoad: true,
      alertOnCriticalHealth: true,
      alertOnSensorFault: false,
      cooldownSeconds: 90
    };
  }

  /**
   * Load stored settings from localStorage
   */
  loadSettings() {
    try {
      const stored = localStorage.getItem(this.storageKey);
      if (stored) {
        return { ...this.getDefaultSettings(), ...JSON.parse(stored) };
      }
    } catch (e) {
      console.warn('[TYRAVEX Email] Could not load saved settings:', e);
    }
    return this.getDefaultSettings();
  }

  /**
   * Save settings to localStorage and re-initialize SDK
   */
  saveSettings(newSettings) {
    this.settings = { ...this.settings, ...newSettings };
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(this.settings));
    } catch (e) {
      console.error('[TYRAVEX Email] Could not save settings:', e);
    }
    this.initEmailJS();
  }

  /**
   * Initializes the EmailJS library if public key is set
   */
  initEmailJS() {
    if (this.settings.publicKey && typeof window.emailjs !== 'undefined') {
      try {
        window.emailjs.init(this.settings.publicKey);
        console.info('[TYRAVEX Email] EmailJS initialized with Public Key.');
      } catch (e) {
        console.error('[TYRAVEX Email] Failed to initialize EmailJS:', e);
      }
    }
  }

  /**
   * Check if service is fully configured
   */
  isConfigured() {
    return Boolean(
      this.settings.enabled &&
      this.settings.publicKey &&
      this.settings.serviceId &&
      this.settings.templateId &&
      this.settings.recipientEmail &&
      this.settings.recipientEmail.includes('@')
    );
  }

  /**
   * Status change listener
   */
  onStatus(callback) {
    this.onStatusChange = callback;
  }

  _updateStatus(status, message) {
    this.lastDeliveryStatus = {
      status,
      message,
      timestamp: new Date().toLocaleTimeString()
    };
    if (this.onStatusChange) {
      this.onStatusChange(this.lastDeliveryStatus);
    }
  }

  /**
   * Check if cooldown period for category has elapsed
   */
  _isCooledDown(category) {
    const cooldownMs = (this.settings.cooldownSeconds || 90) * 1000;
    const now = Date.now();
    const last = this.lastSentTimes[category] || 0;
    return (now - last) >= cooldownMs;
  }

  /**
   * Dispatches an alert email through EmailJS if conditions are met
   * @param {string} category 'temperature' | 'humidity' | 'vibration' | 'load' | 'critical_health' | 'sensor_fault'
   * @param {string} alertTitle Brief title
   * @param {string} alertDetails Descriptive telemetry data
   * @param {object} telemetrySnapshot Current sensor readings
   */
  async triggerAlert(category, alertTitle, alertDetails, telemetrySnapshot = {}) {
    if (!this.settings.enabled) return false;
    if (!this.isConfigured()) {
      this._updateStatus('UNCONFIGURED', 'Alert skipped: EmailJS credentials incomplete in Settings.');
      return false;
    }

    // Check category toggles
    if (category === 'temperature' && !this.settings.alertOnTemperature) return false;
    if (category === 'humidity' && !this.settings.alertOnHumidity) return false;
    if (category === 'vibration' && !this.settings.alertOnVibration) return false;
    if (category === 'load' && !this.settings.alertOnLoad) return false;
    if (category === 'critical_health' && !this.settings.alertOnCriticalHealth) return false;
    if (category === 'sensor_fault' && !this.settings.alertOnSensorFault) return false;

    // Check rate limit cooldown to avoid spam floods
    if (!this._isCooledDown(category)) {
      const remainingSec = Math.ceil(
        ((this.lastSentTimes[category] + (this.settings.cooldownSeconds * 1000)) - Date.now()) / 1000
      );
      console.log(`[TYRAVEX Email] Alert '${category}' suppressed by cooldown (${remainingSec}s remaining)`);
      return false;
    }

    if (this.isSending) {
      console.warn('[TYRAVEX Email] Already sending an email, dropping duplicate request.');
      return false;
    }

    if (typeof window.emailjs === 'undefined') {
      this._updateStatus('FAILED', 'EmailJS SDK not loaded in browser.');
      return false;
    }

    this.isSending = true;
    this._updateStatus('SENDING', `Dispatching ${alertTitle}...`);

    const templateParams = {
      to_email: this.settings.recipientEmail,
      alert_title: `[TYRAVEX ALERT] ${alertTitle}`,
      alert_category: category.toUpperCase(),
      alert_details: alertDetails,
      temperature_reading: telemetrySnapshot.temperature !== null ? `${telemetrySnapshot.temperature} °C (Ambient)` : 'N/A',
      humidity_reading: telemetrySnapshot.humidity !== null ? `${telemetrySnapshot.humidity} %RH` : 'N/A',
      pressure_reading: telemetrySnapshot.pressure !== null ? `${telemetrySnapshot.pressure} hPa (Atmospheric)` : 'N/A',
      vibration_reading: telemetrySnapshot.vibrationRaw !== null ? `ADC Raw ${telemetrySnapshot.vibrationRaw}` : 'N/A',
      load_reading: telemetrySnapshot.loadKg !== null ? `${telemetrySnapshot.loadKg} kg (Suspension)` : 'N/A',
      monitoring_status: telemetrySnapshot.healthStatus || 'N/A',
      timestamp: new Date().toLocaleString(),
      device_name: telemetrySnapshot.device || 'TYRAVEX Hardware Prototype'
    };

    try {
      const response = await window.emailjs.send(
        this.settings.serviceId,
        this.settings.templateId,
        templateParams,
        this.settings.publicKey
      );

      this.lastSentTimes[category] = Date.now();
      this.isSending = false;
      this._updateStatus('SUCCESS', `Alert email delivered to ${this.settings.recipientEmail} (${response.status} ${response.text})`);
      return true;
    } catch (err) {
      this.isSending = false;
      const errorMsg = err?.text || err?.message || 'Network or authentication error';
      this._updateStatus('FAILED', `Email delivery failed: ${errorMsg}`);
      console.error('[TYRAVEX Email] Send failure:', err);
      return false;
    }
  }

  /**
   * Manual test trigger from Settings panel
   */
  async sendTestEmail() {
    if (!this.settings.publicKey || !this.settings.serviceId || !this.settings.templateId || !this.settings.recipientEmail) {
      throw new Error('Please fill in Public Key, Service ID, Template ID, and Recipient Email first.');
    }

    this.initEmailJS();

    return this.triggerAlert(
      'test',
      'Test Alert Verification',
      'This is an automated test message from your TYRAVEX Monitoring Dashboard to verify that your EmailJS integration is operating correctly with the updated hardware sensors.',
      {
        temperature: 30.5,
        humidity: 55.0,
        pressure: 1013.2,
        vibrationRaw: 850,
        loadKg: 3.50,
        healthStatus: 'NORMAL',
        device: 'TYRAVEX Test Runner'
      }
    );
  }
}

// Export singleton instance to window
window.tyravexEmail = new TyravexEmailAlertService();
