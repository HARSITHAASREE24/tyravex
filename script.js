/**
 * TYRAVEX Application Main Controller (Revised Hardware Edition)
 * Binds UI DOM, Web Serial lifecycle, Chart.js instances (5 streams),
 * Settings modal, Tare/Calibration serial commands, and Telemetry updates.
 */

document.addEventListener('DOMContentLoaded', () => {
  // Initialize Lucide icon library
  if (typeof lucide !== 'undefined') {
    lucide.createIcons();
  }

  // Check Web Serial API support
  const isSerialSupported = window.tyravexSerial.isSupported();
  const compatBanner = document.getElementById('compatBanner');
  const connectBtn = document.getElementById('connectSerialBtn');

  if (!isSerialSupported) {
    if (compatBanner) compatBanner.classList.add('active');
    if (connectBtn) {
      connectBtn.disabled = true;
      connectBtn.title = 'Web Serial API is not supported in this browser. Please use Chrome/Edge/Opera desktop.';
    }
    showToast('error', 'Web Serial API unsupported in this browser. Use Chrome or Edge on desktop.');
  }

  // Setup DOM References
  const disconnectBtn = document.getElementById('disconnectSerialBtn');
  const baudSelect = document.getElementById('baudRateSelect');
  const portInfoText = document.getElementById('portInfoText');
  const headerConnBadge = document.getElementById('headerConnBadge');
  const headerConnStatusText = document.getElementById('headerConnStatusText');
  const demoToggle = document.getElementById('demoModeToggle');
  const demoBanner = document.getElementById('demoBanner');

  // Theme & Modal References
  const themeToggleBtn = document.getElementById('themeToggleBtn');
  const themeToggleIcon = document.getElementById('themeToggleIcon');
  const settingsModal = document.getElementById('settingsModal');
  const openSettingsBtn = document.getElementById('openSettingsBtn');
  const closeSettingsBtn = document.getElementById('closeSettingsBtn');
  const saveSettingsBtn = document.getElementById('saveSettingsBtn');
  const resetDefaultsBtn = document.getElementById('resetDefaultsBtn');
  const sendTestEmailBtn = document.getElementById('sendTestEmailBtn');
  const emailStatusText = document.getElementById('emailStatusText');

  // Chart Controls
  const pauseChartsBtn = document.getElementById('pauseChartsBtn');
  const pauseChartsText = document.getElementById('pauseChartsText');
  const resetChartsBtn = document.getElementById('resetChartsBtn');
  const exportCsvBtn = document.getElementById('exportCsvBtn');

  // --------------------------------------------------------------------------
  // Chart.js Telemetry Setup (5 Independent Sensor Waveforms)
  // --------------------------------------------------------------------------
  const chartCommonOptions = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: '#0f172a',
        borderColor: 'rgba(255, 255, 255, 0.1)',
        borderWidth: 1,
        titleFont: { family: 'JetBrains Mono', size: 11 },
        bodyFont: { family: 'JetBrains Mono', size: 12 },
        padding: 8
      }
    },
    scales: {
      x: {
        display: true,
        grid: { color: 'rgba(255, 255, 255, 0.05)' },
        ticks: { color: '#64748b', font: { family: 'JetBrains Mono', size: 9 }, maxTicksLimit: 6 }
      },
      y: {
        display: true,
        grid: { color: 'rgba(255, 255, 255, 0.05)' },
        ticks: { color: '#94a3b8', font: { family: 'JetBrains Mono', size: 10 } }
      }
    }
  };

  // 1. Temperature Chart (DHT11)
  const tempCanvas = document.getElementById('tempChartCanvas').getContext('2d');
  const tempChart = new Chart(tempCanvas, {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label: 'Ambient Temp (°C)',
        data: [],
        borderColor: '#00f0ff',
        backgroundColor: 'rgba(0, 240, 255, 0.08)',
        fill: true,
        tension: 0.25,
        borderWidth: 2,
        pointRadius: 2,
        pointHoverRadius: 4,
        pointBackgroundColor: '#00f0ff'
      }]
    },
    options: {
      ...chartCommonOptions,
      scales: {
        ...chartCommonOptions.scales,
        y: {
          ...chartCommonOptions.scales.y,
          title: { display: true, text: '°C', color: '#64748b', font: { size: 10 } },
          suggestedMin: 15,
          suggestedMax: 45
        }
      }
    }
  });

  // 2. Humidity Chart (DHT11)
  const humidityCanvas = document.getElementById('humidityChartCanvas').getContext('2d');
  const humidityChart = new Chart(humidityCanvas, {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label: 'Humidity (%RH)',
        data: [],
        borderColor: '#06b6d4',
        backgroundColor: 'rgba(6, 182, 212, 0.08)',
        fill: true,
        tension: 0.2,
        borderWidth: 2,
        pointRadius: 2,
        pointHoverRadius: 4,
        pointBackgroundColor: '#06b6d4'
      }]
    },
    options: {
      ...chartCommonOptions,
      scales: {
        ...chartCommonOptions.scales,
        y: {
          ...chartCommonOptions.scales.y,
          title: { display: true, text: '%RH', color: '#64748b', font: { size: 10 } },
          suggestedMin: 20,
          suggestedMax: 90
        }
      }
    }
  });

  // 3. Tire Pressure Chart (BMP280)
  const pressureCanvas = document.getElementById('pressureChartCanvas').getContext('2d');
  const pressureChart = new Chart(pressureCanvas, {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label: 'Tire Pressure',
        data: [],
        borderColor: '#38bdf8',
        backgroundColor: 'rgba(56, 189, 248, 0.08)',
        fill: true,
        tension: 0.2,
        borderWidth: 2,
        pointRadius: 2,
        pointHoverRadius: 4,
        pointBackgroundColor: '#38bdf8'
      }]
    },
    options: {
      ...chartCommonOptions,
      scales: {
        ...chartCommonOptions.scales,
        y: {
          ...chartCommonOptions.scales.y,
          title: { display: true, text: 'hPa', color: '#64748b', font: { size: 10 } },
          suggestedMin: 980,
          suggestedMax: 1040
        }
      }
    }
  });

  // 4. Vibration Intensity Chart
  const vibCanvas = document.getElementById('vibrationChartCanvas').getContext('2d');
  const vibChart = new Chart(vibCanvas, {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label: 'Vibration Intensity (%)',
        data: [],
        borderColor: '#f59e0b',
        backgroundColor: 'rgba(245, 158, 11, 0.08)',
        fill: true,
        tension: 0.15,
        borderWidth: 2,
        pointRadius: 2,
        pointHoverRadius: 4,
        pointBackgroundColor: '#f59e0b'
      }]
    },
    options: {
      ...chartCommonOptions,
      scales: {
        ...chartCommonOptions.scales,
        y: {
          ...chartCommonOptions.scales.y,
          title: { display: true, text: '% Intensity', color: '#64748b', font: { size: 10 } },
          suggestedMin: 0,
          suggestedMax: 100
        }
      }
    }
  });

  // 5. Suspension Load Chart (HX711)
  const loadCanvas = document.getElementById('loadChartCanvas').getContext('2d');
  const loadChart = new Chart(loadCanvas, {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label: 'Suspension Load (kg)',
        data: [],
        borderColor: '#10b981',
        backgroundColor: 'rgba(16, 185, 129, 0.08)',
        fill: true,
        tension: 0.2,
        borderWidth: 2,
        pointRadius: 2,
        pointHoverRadius: 4,
        pointBackgroundColor: '#10b981'
      }]
    },
    options: {
      ...chartCommonOptions,
      scales: {
        ...chartCommonOptions.scales,
        y: {
          ...chartCommonOptions.scales.y,
          title: { display: true, text: 'kg', color: '#64748b', font: { size: 10 } },
          suggestedMin: 0,
          suggestedMax: 10
        }
      }
    }
  });

  // Empty state elements
  const tempChartEmpty = document.getElementById('tempChartEmpty');
  const humidityChartEmpty = document.getElementById('humidityChartEmpty');
  const pressureChartEmpty = document.getElementById('pressureChartEmpty');
  const vibChartEmpty = document.getElementById('vibrationChartEmpty');
  const loadChartEmpty = document.getElementById('loadChartEmpty');

  const allCharts = [tempChart, humidityChart, pressureChart, vibChart, loadChart];

  // --------------------------------------------------------------------------
  // Theme Management (Light / Dark Modes)
  // --------------------------------------------------------------------------
  function getEffectiveTheme(preference) {
    if (preference === 'system') {
      return (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
    }
    return preference === 'light' ? 'light' : 'dark';
  }

  function updateChartsTheme(effectiveTheme) {
    const isLight = effectiveTheme === 'light';
    const gridColor = isLight ? 'rgba(15, 23, 42, 0.08)' : 'rgba(255, 255, 255, 0.05)';
    const tickColor = isLight ? '#475569' : '#94a3b8';
    const titleColor = isLight ? '#475569' : '#64748b';
    const tooltipBg = isLight ? '#ffffff' : '#0f172a';
    const tooltipBorder = isLight ? 'rgba(15, 23, 42, 0.12)' : 'rgba(255, 255, 255, 0.1)';
    const tooltipTitle = isLight ? '#0f172a' : '#f8fafc';
    const tooltipBody = isLight ? '#334155' : '#e2e8f0';

    allCharts.forEach(chart => {
      if (!chart) return;
      if (chart.options.scales.x) {
        chart.options.scales.x.grid.color = gridColor;
        chart.options.scales.x.ticks.color = tickColor;
      }
      if (chart.options.scales.y) {
        chart.options.scales.y.grid.color = gridColor;
        chart.options.scales.y.ticks.color = tickColor;
        if (chart.options.scales.y.title) {
          chart.options.scales.y.title.color = titleColor;
        }
      }
      if (chart.options.plugins && chart.options.plugins.tooltip) {
        chart.options.plugins.tooltip.backgroundColor = tooltipBg;
        chart.options.plugins.tooltip.borderColor = tooltipBorder;
        chart.options.plugins.tooltip.titleColor = tooltipTitle;
        chart.options.plugins.tooltip.bodyColor = tooltipBody;
      }
      chart.update('none');
    });
  }

  function applyTheme(preference, showToastMsg = false) {
    const effective = getEffectiveTheme(preference);
    document.documentElement.setAttribute('data-theme', effective);

    if (themeToggleBtn && themeToggleIcon) {
      if (effective === 'light') {
        themeToggleIcon.setAttribute('data-lucide', 'moon');
        themeToggleBtn.setAttribute('title', 'Switch to Dark Mode (Current: Light Mode)');
        themeToggleBtn.setAttribute('aria-label', 'Switch to Dark Mode');
      } else {
        themeToggleIcon.setAttribute('data-lucide', 'sun');
        themeToggleBtn.setAttribute('title', 'Switch to Light Mode (Current: Dark Mode)');
        themeToggleBtn.setAttribute('aria-label', 'Switch to Light Mode');
      }
      if (typeof lucide !== 'undefined') {
        lucide.createIcons();
      }
    }

    const cfgSelect = document.getElementById('cfgThemeMode');
    if (cfgSelect) {
      cfgSelect.value = preference;
    }

    updateChartsTheme(effective);

    if (showToastMsg) {
      showToast('info', effective === 'light' ? 'Daylight Light Mode activated.' : 'Automotive Dark Mode activated.');
    }
  }

  if (themeToggleBtn) {
    themeToggleBtn.addEventListener('click', () => {
      const currentEffective = document.documentElement.getAttribute('data-theme') || 'dark';
      const newTheme = currentEffective === 'light' ? 'dark' : 'light';
      localStorage.setItem('tyravex_theme', newTheme);
      applyTheme(newTheme, true);
    });
  }

  // Initial Theme Application
  const initialThemePref = localStorage.getItem('tyravex_theme') || 'dark';
  applyTheme(initialThemePref, false);

  // --------------------------------------------------------------------------
  // Web Serial Event Handlers
  // --------------------------------------------------------------------------
  window.tyravexSerial.on('connect', (info) => {
    if (demoToggle.checked) {
      demoToggle.checked = false;
      window.tyravexEngine.stopDemoMode();
      demoBanner.style.display = 'none';
    }

    connectBtn.disabled = true;
    disconnectBtn.disabled = false;
    baudSelect.disabled = true;

    portInfoText.textContent = `${info.usbProductId} (${info.baudRate} baud)`;
    headerConnBadge.className = 'connection-badge connected';
    headerConnStatusText.textContent = 'CONNECTED';

    window.tyravexEngine.setConnected(true, info);
    showToast('success', `ESP32 connected successfully at ${info.baudRate} baud.`);
  });

  window.tyravexSerial.on('disconnect', (reason) => {
    connectBtn.disabled = false;
    disconnectBtn.disabled = true;
    baudSelect.disabled = false;

    portInfoText.textContent = 'No Port Selected';
    headerConnBadge.className = 'connection-badge';
    headerConnStatusText.textContent = 'DISCONNECTED';

    window.tyravexEngine.setConnected(false, null);
    showToast('warning', `ESP32 disconnected: ${reason}`);
  });

  window.tyravexSerial.on('data', (packet) => {
    window.tyravexEngine.processPacket(packet);
  });

  window.tyravexSerial.on('error', (err) => {
    window.tyravexEngine.state.commErrors++;
    showToast('error', err);
  });

  // Connect Click Handler
  connectBtn.addEventListener('click', async () => {
    const baud = parseInt(baudSelect.value, 10) || 115200;
    try {
      await window.tyravexSerial.connect(baud);
    } catch (e) {
      console.warn('[TYRAVEX] Connect aborted or failed:', e);
    }
  });

  // Disconnect Click Handler
  disconnectBtn.addEventListener('click', async () => {
    await window.tyravexSerial.disconnect();
  });

  // Demo Mode Switch Handler
  demoToggle.addEventListener('change', (e) => {
    if (e.target.checked) {
      if (window.tyravexSerial.isConnected) {
        window.tyravexSerial.disconnect();
      }
      window.tyravexEngine.startDemoMode();
      demoBanner.style.display = 'flex';
      headerConnBadge.className = 'connection-badge demo';
      headerConnStatusText.textContent = 'DEMO MODE';
      portInfoText.textContent = 'Simulated ESP32 Stream';
      showToast('info', 'DEMO MODE activated (Simulated DHT11, BMP280, Vibration, and HX711)');
    } else {
      window.tyravexEngine.stopDemoMode();
      demoBanner.style.display = 'none';
      headerConnBadge.className = 'connection-badge';
      headerConnStatusText.textContent = 'DISCONNECTED';
      portInfoText.textContent = 'No Port Selected';
      showToast('info', 'DEMO MODE deactivated.');
    }
  });

  // --------------------------------------------------------------------------
  // Unit Toggles: Pressure & Load
  // --------------------------------------------------------------------------
  const pressureUnitButtons = document.querySelectorAll('#pressureUnitToggle .unit-btn');
  pressureUnitButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      pressureUnitButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const newUnit = btn.dataset.unit;
      window.tyravexEngine.saveSettings({ pressureUnit: newUnit });
      document.getElementById('chartPressureUnitLabel').textContent = newUnit;
      showToast('info', `Tire pressure unit switched to ${newUnit}.`);
    });
  });

  const loadUnitButtons = document.querySelectorAll('#loadUnitToggle .unit-btn');
  loadUnitButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      loadUnitButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const newUnit = btn.dataset.unit;
      window.tyravexEngine.saveSettings({ loadDisplayUnit: newUnit });
      document.getElementById('chartLoadUnitLabel').textContent = newUnit;
      showToast('info', `Suspension load display unit switched to ${newUnit}.`);
    });
  });

  // --------------------------------------------------------------------------
  // Hardware Load Cell Tare & Calibration Actions
  // --------------------------------------------------------------------------
  async function triggerTare() {
    if (!window.tyravexSerial.isConnected && !window.tyravexEngine.state.isDemoMode) {
      showToast('warning', 'Please connect the ESP32 via USB Serial first to tare the load cell.');
      return;
    }

    if (window.tyravexSerial.isConnected) {
      showToast('info', 'Sending TARE command to ESP32 (Zeroing unloaded load cell)...');
      const sent = await window.tyravexSerial.sendCommand('TARE');
      if (sent) {
        showToast('success', 'TARE command dispatched to ESP32.');
        window.tyravexEngine.addEventLog('INFO', 'Sent TARE command to ESP32 firmware.');
      }
    } else {
      showToast('success', 'Demo load cell zeroed (Tare complete).');
    }
  }

  async function triggerCalibration(weightInputId) {
    const weightInput = document.getElementById(weightInputId);
    if (!weightInput) return;

    const weightVal = parseFloat(weightInput.value);
    if (isNaN(weightVal) || weightVal <= 0.05 || weightVal > 10.0) {
      showToast('error', 'Please enter a valid reference test weight between 0.1 kg and 10.0 kg.');
      return;
    }

    if (!window.tyravexSerial.isConnected && !window.tyravexEngine.state.isDemoMode) {
      showToast('warning', 'Please connect the ESP32 via USB Serial first to calibrate the load cell.');
      return;
    }

    if (window.tyravexSerial.isConnected) {
      const cmd = `CAL:${weightVal.toFixed(2)}`;
      showToast('info', `Sending calibration command: ${cmd} ...`);
      const sent = await window.tyravexSerial.sendCommand(cmd);
      if (sent) {
        showToast('success', `Calibrating scale factor with ${weightVal.toFixed(2)} kg reference weight.`);
        window.tyravexEngine.addEventLog('INFO', `Sent command ${cmd} to ESP32.`);
      }
    } else {
      showToast('success', `Demo load cell calibrated with ${weightVal.toFixed(2)} kg reference weight.`);
    }
  }

  // Bind Card Calibration Buttons
  const cardTareBtn = document.getElementById('cardTareBtn');
  if (cardTareBtn) cardTareBtn.addEventListener('click', triggerTare);

  const cardCalibrateBtn = document.getElementById('cardCalibrateBtn');
  if (cardCalibrateBtn) cardCalibrateBtn.addEventListener('click', () => triggerCalibration('cardCalWeightInput'));

  // Bind Modal Calibration Buttons
  const modalTareBtn = document.getElementById('modalTareBtn');
  if (modalTareBtn) modalTareBtn.addEventListener('click', triggerTare);

  const modalCalibrateBtn = document.getElementById('modalCalibrateBtn');
  if (modalCalibrateBtn) modalCalibrateBtn.addEventListener('click', () => triggerCalibration('modalCalWeightInput'));

  // --------------------------------------------------------------------------
  // Chart Pause & Reset Handlers
  // --------------------------------------------------------------------------
  pauseChartsBtn.addEventListener('click', () => {
    const isPaused = window.tyravexEngine.toggleChartPause();
    pauseChartsText.textContent = isPaused ? 'Resume' : 'Pause';
    pauseChartsBtn.classList.toggle('active', isPaused);
  });

  resetChartsBtn.addEventListener('click', () => {
    window.tyravexEngine.resetChartHistory();
    showToast('info', 'Telemetry chart histories reset.');
  });

  // Export CSV Handler
  exportCsvBtn.addEventListener('click', () => {
    window.tyravexEngine.exportLogsToCSV();
  });

  // Event Log Filter Tabs
  const filterTabs = document.querySelectorAll('.filter-tab');
  filterTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      filterTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      window.tyravexEngine.activeLogFilter = tab.dataset.filter;
      renderLogTable(window.tyravexEngine.eventLogs, tab.dataset.filter);
    });
  });

  // --------------------------------------------------------------------------
  // Telemetry Engine Subscription: UI Dashboard Updates
  // --------------------------------------------------------------------------
  window.tyravexEngine.subscribe((state, chartData, logs) => {
    const settings = window.tyravexEngine.settings;

    // --- CARD 1: Overall Monitoring Status ---
    const scoreValEl = document.getElementById('healthScoreDisplay');
    const condEl = document.getElementById('healthConditionDisplay');
    const badgeEl = document.getElementById('healthStatusBadge');
    const connEl = document.getElementById('monitoringConnDisplay');
    const availEl = document.getElementById('monitoringAvailabilityDisplay');
    const updatedEl = document.getElementById('healthLastUpdatedDisplay');
    const circle = document.getElementById('gaugeProgressCircle');
    const warningsBox = document.getElementById('healthWarningsBox');

    if (state.healthScore !== null) {
      scoreValEl.textContent = `${state.healthScore}%`;
      const circumference = 439.82;
      const offset = circumference - (circumference * state.healthScore / 100);
      circle.style.strokeDashoffset = offset;

      if (state.healthStatus === 'NORMAL') {
        circle.style.stroke = '#10b981';
      } else if (state.healthStatus === 'WARNING') {
        circle.style.stroke = '#f59e0b';
      } else {
        circle.style.stroke = '#ef4444';
      }
    } else {
      scoreValEl.textContent = '--';
      circle.style.strokeDashoffset = 439.82;
      circle.style.stroke = '#64748b';
    }

    condEl.textContent = state.healthCondition;
    badgeEl.textContent = state.healthStatus;
    badgeEl.className = `card-status-badge ${state.healthStatus.toLowerCase().replace(' ', '-')}`;

    connEl.textContent = state.isConnected
      ? (state.isDemoMode ? 'SIMULATED DEMO' : 'ONLINE (USB UART)')
      : 'DISCONNECTED';

    const activeSensors = (state.temperatureValid ? 1 : 0) +
                          (state.pressureValid ? 1 : 0) +
                          (state.vibrationAnalogValid && state.vibrationRaw !== null ? 1 : 0) +
                          (state.loadValid ? 1 : 0);
    availEl.textContent = `${activeSensors} / 4 Probes Online`;

    updatedEl.textContent = state.lastPacketTime
      ? new Date(state.lastPacketTime).toLocaleTimeString()
      : 'Never';

    // Warnings list
    if (state.activeWarnings && state.activeWarnings.length > 0) {
      warningsBox.innerHTML = `<strong>System Notifications:</strong><br>• ` + state.activeWarnings.join('<br>• ');
      warningsBox.classList.add('active');
    } else {
      warningsBox.classList.remove('active');
    }

    // --- CARD 2: Ambient Temperature (DHT11) ---
    const tempDisp = document.getElementById('tempCurrentDisplay');
    const tempBadge = document.getElementById('tempStatusBadge');
    const tempMin = document.getElementById('tempMinDisplay');
    const tempMax = document.getElementById('tempMaxDisplay');
    const tempTrend = document.getElementById('tempTrendDisplay');

    if (state.temperatureValid && state.temperature !== null) {
      tempDisp.textContent = state.temperature.toFixed(1);
      tempMin.textContent = `${state.tempMin.toFixed(1)} °C`;
      tempMax.textContent = `${state.tempMax.toFixed(1)} °C`;
      tempTrend.textContent = state.tempTrend;

      if (state.temperature >= settings.tempCritC) {
        tempBadge.textContent = 'CRITICAL';
        tempBadge.className = 'card-status-badge critical';
      } else if (state.temperature >= settings.tempWarnC) {
        tempBadge.textContent = 'WARNING';
        tempBadge.className = 'card-status-badge warning';
      } else {
        tempBadge.textContent = 'NORMAL';
        tempBadge.className = 'card-status-badge good';
      }
    } else {
      tempDisp.textContent = '--';
      tempBadge.textContent = state.isConnected ? 'SENSOR FAULT' : 'NO DATA';
      tempBadge.className = 'card-status-badge' + (state.isConnected ? ' critical' : '');
    }

    // --- CARD 3: Relative Humidity (DHT11) ---
    const humDisp = document.getElementById('humidityCurrentDisplay');
    const humBadge = document.getElementById('humidityStatusBadge');
    const humStatusEl = document.getElementById('humidityStatusDisplay');
    const humDewEl = document.getElementById('humidityDewPointDisplay');

    if (state.humidityValid && state.humidity !== null) {
      humDisp.textContent = state.humidity.toFixed(1);
      humStatusEl.textContent = state.humidityStatus;

      if (state.humidity > settings.humidityWarnHigh || state.humidity < settings.humidityWarnLow) {
        humBadge.textContent = 'WARNING';
        humBadge.className = 'card-status-badge warning';
        humDewEl.textContent = state.humidity > settings.humidityWarnHigh ? 'High Moisture Risk' : 'Dry Environment';
      } else {
        humBadge.textContent = 'OPTIMAL';
        humBadge.className = 'card-status-badge good';
        humDewEl.textContent = 'Optimal Comfort';
      }
    } else {
      humDisp.textContent = '--';
      humStatusEl.textContent = state.isConnected ? 'SENSOR FAULT' : 'Awaiting Sensor';
      humBadge.textContent = state.isConnected ? 'SENSOR FAULT' : 'NO DATA';
      humBadge.className = 'card-status-badge' + (state.isConnected ? ' critical' : '');
      humDewEl.textContent = '--';
    }

    // --- CARD 4: Tire Pressure (BMP280) ---
    const pressDisp = document.getElementById('pressureCurrentDisplay');
    const pressUnitEl = document.getElementById('pressureCurrentUnit');
    const pressStatusEl = document.getElementById('pressureStatusText');
    const pressTrendEl = document.getElementById('pressureTrendDisplay');

    const curPressUnit = settings.pressureUnit || 'PSI';
    pressUnitEl.textContent = curPressUnit;

    if (state.pressureValid && state.tirePressureDisplay !== null) {
      pressDisp.textContent = state.tirePressureDisplay;
      pressStatusEl.textContent = 'BMP280 OK (Tire Probe)';
      pressTrendEl.textContent = state.pressureTrend;
    } else {
      pressDisp.textContent = '--';
      pressStatusEl.textContent = state.isConnected ? 'BMP280 FAULT' : 'AWAITING BMP280';
      pressTrendEl.textContent = 'Steady';
    }

    // --- CARD 5: Vibration Monitoring (AO & DO) ---
    const vibDisp = document.getElementById('vibrationCurrentDisplay');
    const vibUnitEl = document.getElementById('vibrationCurrentUnit');
    const vibBadge = document.getElementById('vibrationStatusBadge');
    const vibRawEl = document.getElementById('vibrationRawDisplay');
    const vibPeakEl = document.getElementById('vibrationPeakDisplay');
    const vibDigitalEl = document.getElementById('vibrationDigitalDisplay');
    const vibEventsEl = document.getElementById('vibrationEventCountDisplay');

    if (state.vibrationAnalogValid && state.vibrationRaw !== null) {
      vibDisp.textContent = state.vibrationNormalized !== null ? state.vibrationNormalized : '--';
      vibUnitEl.textContent = '% (Norm)';
      vibRawEl.textContent = `${state.vibrationRaw} / 4095`;
      vibPeakEl.textContent = `${state.peakVibrationRaw} ADC`;

      if (state.vibrationRaw >= settings.vibrationCritRaw) {
        vibBadge.textContent = 'CRITICAL';
        vibBadge.className = 'card-status-badge critical';
      } else if (state.vibrationRaw >= settings.vibrationWarnRaw) {
        vibBadge.textContent = 'ELEVATED';
        vibBadge.className = 'card-status-badge warning';
      } else {
        vibBadge.textContent = 'NOMINAL';
        vibBadge.className = 'card-status-badge good';
      }
    } else {
      vibDisp.textContent = '--';
      vibRawEl.textContent = '--';
      vibPeakEl.textContent = '--';
      vibBadge.textContent = 'NO DATA';
      vibBadge.className = 'card-status-badge';
    }

    vibDigitalEl.textContent = state.vibrationDigitalStatus;
    vibEventsEl.textContent = state.vibrationEventCount;

    // --- CARD 6: Tire Load on Suspension (10 kg Load Cell + HX711) ---
    const loadDisp = document.getElementById('loadCurrentDisplay');
    const loadUnitEl = document.getElementById('loadCurrentUnit');
    const loadCalibEl = document.getElementById('loadCalibrationStatus');
    const loadPeakEl = document.getElementById('loadPeakDisplay');
    const loadMinEl = document.getElementById('loadMinDisplay');
    const loadRawEl = document.getElementById('loadRawDisplay');
    const loadTrendEl = document.getElementById('loadTrendDisplay');

    const curLoadUnit = settings.loadDisplayUnit || 'kg';
    loadUnitEl.textContent = curLoadUnit;

    if (loadRawEl) {
      loadRawEl.textContent = state.loadRaw ? `${state.loadRaw.toLocaleString()} counts` : '-- counts';
    }

    if (state.loadValid && state.loadKg !== null) {
      const val = curLoadUnit === 'N' ? state.loadN : state.loadKg;
      loadDisp.textContent = val !== null ? val.toFixed(2) : '--';

      loadCalibEl.textContent = 'CALIBRATED';
      loadCalibEl.style.color = 'var(--status-good)';

      const peakVal = curLoadUnit === 'N' && state.peakLoadKg !== null ? (state.peakLoadKg * 9.80665).toFixed(2) : (state.peakLoadKg !== null ? state.peakLoadKg.toFixed(2) : '--');
      const minVal = curLoadUnit === 'N' && state.minLoadKg !== null ? (state.minLoadKg * 9.80665).toFixed(2) : (state.minLoadKg !== null ? state.minLoadKg.toFixed(2) : '--');

      loadPeakEl.textContent = `${peakVal} ${curLoadUnit}`;
      loadMinEl.textContent = `${minVal} ${curLoadUnit}`;
      loadTrendEl.textContent = state.loadTrend;
    } else {
      loadDisp.textContent = '--';
      loadCalibEl.textContent = state.loadCalibrated ? 'AMPLIFIER FAULT' : 'UNCALIBRATED';
      loadCalibEl.style.color = state.loadCalibrated ? 'var(--status-crit)' : 'var(--status-warn)';
      loadPeakEl.textContent = `-- ${curLoadUnit}`;
      loadMinEl.textContent = `-- ${curLoadUnit}`;
      loadTrendEl.textContent = 'Stable';
    }

    // --- CARD 7: Sensor Connection Status ---
    const commBadge = document.getElementById('commStatusBadge');
    const pillEsp32 = document.getElementById('sensorEsp32Pill');
    const pillDht11 = document.getElementById('sensorDht11Pill');
    const pillBmp280 = document.getElementById('sensorBmp280Pill');
    const pillVib = document.getElementById('sensorVibrationPill');
    const pillHx711 = document.getElementById('sensorHx711Pill');
    const packetsDisp = document.getElementById('packetsCountDisplay');
    const invalidDisp = document.getElementById('invalidPacketsDisplay');
    const errorsDisp = document.getElementById('commErrorsDisplay');
    const lastValidDisp = document.getElementById('lastPacketTimeDisplay');

    packetsDisp.textContent = state.packetCount;
    invalidDisp.textContent = state.invalidPacketCount;
    errorsDisp.textContent = state.commErrors;
    lastValidDisp.textContent = state.lastPacketTime
      ? new Date(state.lastPacketTime).toLocaleTimeString()
      : 'Never';

    if (state.isConnected) {
      commBadge.textContent = state.isDemoMode ? 'DEMO' : 'STREAMING';
      commBadge.className = 'card-status-badge good';
      pillEsp32.textContent = state.isDemoMode ? 'SIMULATED' : 'ONLINE';
      pillEsp32.className = 'sensor-pill ok';
    } else {
      commBadge.textContent = 'OFFLINE';
      commBadge.className = 'card-status-badge';
      pillEsp32.textContent = 'DISCONNECTED';
      pillEsp32.className = 'sensor-pill none';
    }

    // DHT11
    if (state.temperatureValid) {
      pillDht11.textContent = 'OPERATIONAL';
      pillDht11.className = 'sensor-pill ok';
    } else if (state.isConnected) {
      pillDht11.textContent = 'FAULT / DISCONNECTED';
      pillDht11.className = 'sensor-pill error';
    } else {
      pillDht11.textContent = 'NO DATA';
      pillDht11.className = 'sensor-pill none';
    }

    // BMP280
    if (state.pressureValid) {
      pillBmp280.textContent = 'OPERATIONAL (I2C)';
      pillBmp280.className = 'sensor-pill ok';
    } else if (state.isConnected) {
      pillBmp280.textContent = 'FAULT (I2C 0x76/0x77)';
      pillBmp280.className = 'sensor-pill error';
    } else {
      pillBmp280.textContent = 'NO DATA';
      pillBmp280.className = 'sensor-pill none';
    }

    // Vibration Module
    if (state.vibrationAnalogValid && state.vibrationRaw !== null) {
      pillVib.textContent = 'OPERATIONAL (AO & DO)';
      pillVib.className = 'sensor-pill ok';
    } else if (state.isConnected) {
      pillVib.textContent = 'FAULT';
      pillVib.className = 'sensor-pill error';
    } else {
      pillVib.textContent = 'NO DATA';
      pillVib.className = 'sensor-pill none';
    }

    // HX711 Load Cell
    if (state.loadValid) {
      pillHx711.textContent = 'CALIBRATED & READY';
      pillHx711.className = 'sensor-pill ok';
    } else if (state.isConnected && state.hx711Valid && !state.loadCalibrated) {
      pillHx711.textContent = 'UNCALIBRATED';
      pillHx711.className = 'sensor-pill uncalibrated';
    } else if (state.isConnected) {
      pillHx711.textContent = 'AMPLIFIER FAULT';
      pillHx711.className = 'sensor-pill error';
    } else {
      pillHx711.textContent = 'NO DATA';
      pillHx711.className = 'sensor-pill none';
    }

    // --- CARD 8: Live Charts Update (5 Waveforms) ---
    if (chartData.labels.length > 0) {
      tempChartEmpty.classList.add('hidden');
      humidityChartEmpty.classList.add('hidden');
      pressureChartEmpty.classList.add('hidden');
      vibChartEmpty.classList.add('hidden');
      loadChartEmpty.classList.add('hidden');

      // 1. Temp Chart
      tempChart.data.labels = chartData.labels;
      tempChart.data.datasets[0].data = chartData.temperature;
      tempChart.update('none');

      // 2. Humidity Chart
      humidityChart.data.labels = chartData.labels;
      humidityChart.data.datasets[0].data = chartData.humidity;
      humidityChart.update('none');

      // 3. Pressure Chart
      pressureChart.data.labels = chartData.labels;
      pressureChart.data.datasets[0].label = `Tire Pressure (${curPressUnit})`;
      pressureChart.data.datasets[0].data = chartData.pressure;
      pressureChart.update('none');

      // 4. Vibration Chart
      vibChart.data.labels = chartData.labels;
      vibChart.data.datasets[0].data = chartData.vibration;
      vibChart.update('none');

      // 5. Load Chart
      loadChart.data.labels = chartData.labels;
      loadChart.data.datasets[0].label = `Tire Load (${curLoadUnit})`;
      const convertedLoadHistory = chartData.load.map(val => {
        if (val === null) return null;
        return curLoadUnit === 'N' ? Number((val * 9.80665).toFixed(2)) : val;
      });
      loadChart.data.datasets[0].data = convertedLoadHistory;
      loadChart.update('none');
    } else {
      tempChartEmpty.classList.remove('hidden');
      humidityChartEmpty.classList.remove('hidden');
      pressureChartEmpty.classList.remove('hidden');
      vibChartEmpty.classList.remove('hidden');
      loadChartEmpty.classList.remove('hidden');
    }

    // --- CARD 9: Event Log Table Update ---
    renderLogTable(logs, window.tyravexEngine.activeLogFilter);
  });

  // Render Table helper
  function renderLogTable(logs, filter) {
    const tbody = document.getElementById('eventLogTableBody');
    const filtered = filter === 'ALL'
      ? logs
      : logs.filter(item => item.severity === filter);

    if (filtered.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="9" class="table-empty-row">
            No events match the selected '${filter}' filter.
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = filtered.slice(0, 50).map(item => `
      <tr>
        <td>${item.timestamp}</td>
        <td><span class="log-badge ${item.severity.toLowerCase()}">${item.severity}</span></td>
        <td>${item.status}</td>
        <td>${item.temperature}</td>
        <td>${item.humidity || '--'}</td>
        <td>${item.pressure}</td>
        <td>${item.vibration}</td>
        <td>${item.load}</td>
        <td>${escapeHtml(item.description)}</td>
      </tr>
    `).join('');
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // --------------------------------------------------------------------------
  // Settings Modal Controller
  // --------------------------------------------------------------------------
  function openSettings() {
    const s = window.tyravexEngine.settings;
    const es = window.tyravexEmail.settings;

    // Theme Preference
    const cfgTheme = document.getElementById('cfgThemeMode');
    if (cfgTheme) {
      cfgTheme.value = localStorage.getItem('tyravex_theme') || 'dark';
    }

    // Populate environmental & sensor fields
    document.getElementById('cfgTempWarn').value = s.tempWarnC;
    document.getElementById('cfgTempCrit').value = s.tempCritC;
    document.getElementById('cfgHumidityWarnLow').value = s.humidityWarnLow;
    document.getElementById('cfgHumidityWarnHigh').value = s.humidityWarnHigh;
    document.getElementById('cfgPressureUnit').value = s.pressureUnit;
    document.getElementById('cfgChartPoints').value = s.chartHistoryLength;
    document.getElementById('cfgVibWarnRaw').value = s.vibrationWarnRaw;
    document.getElementById('cfgVibCritRaw').value = s.vibrationCritRaw;
    document.getElementById('cfgLoadWarnKg').value = s.loadWarnKg;
    document.getElementById('cfgLoadCritKg').value = s.loadCritKg;

    // EmailJS
    document.getElementById('cfgEmailEnabled').checked = es.enabled;
    document.getElementById('cfgEmailPubKey').value = es.publicKey || '';
    document.getElementById('cfgEmailServiceId').value = es.serviceId || '';
    document.getElementById('cfgEmailTemplateId').value = es.templateId || '';
    document.getElementById('cfgEmailRecipient').value = es.recipientEmail || '';
    document.getElementById('cfgEmailCooldown').value = es.cooldownSeconds || 90;
    document.getElementById('cfgEmailCritHealth').checked = es.alertOnCriticalHealth;
    document.getElementById('cfgEmailTemp').checked = es.alertOnTemperature;
    document.getElementById('cfgEmailHumidity').checked = es.alertOnHumidity;
    document.getElementById('cfgEmailVib').checked = es.alertOnVibration;
    document.getElementById('cfgEmailLoad').checked = es.alertOnLoad;
    document.getElementById('cfgEmailSensorFault').checked = es.alertOnSensorFault;

    settingsModal.classList.add('open');
    settingsModal.setAttribute('aria-hidden', 'false');
  }

  function closeSettings() {
    settingsModal.classList.remove('open');
    settingsModal.setAttribute('aria-hidden', 'true');
  }

  openSettingsBtn.addEventListener('click', openSettings);
  closeSettingsBtn.addEventListener('click', closeSettings);

  // Close when clicking outside panel
  settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) closeSettings();
  });

  // Save Settings
  saveSettingsBtn.addEventListener('click', () => {
    const form = document.getElementById('settingsForm');
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }

    // Save Theme Priority
    const themeSelect = document.getElementById('cfgThemeMode');
    if (themeSelect) {
      const chosenTheme = themeSelect.value;
      localStorage.setItem('tyravex_theme', chosenTheme);
      applyTheme(chosenTheme, false);
    }

    const newEngineSettings = {
      tempWarnC: parseFloat(document.getElementById('cfgTempWarn').value),
      tempCritC: parseFloat(document.getElementById('cfgTempCrit').value),
      humidityWarnLow: parseFloat(document.getElementById('cfgHumidityWarnLow').value),
      humidityWarnHigh: parseFloat(document.getElementById('cfgHumidityWarnHigh').value),
      pressureUnit: document.getElementById('cfgPressureUnit').value,
      chartHistoryLength: parseInt(document.getElementById('cfgChartPoints').value, 10),
      vibrationWarnRaw: parseInt(document.getElementById('cfgVibWarnRaw').value, 10),
      vibrationCritRaw: parseInt(document.getElementById('cfgVibCritRaw').value, 10),
      loadWarnKg: parseFloat(document.getElementById('cfgLoadWarnKg').value),
      loadCritKg: parseFloat(document.getElementById('cfgLoadCritKg').value)
    };

    const newEmailSettings = {
      enabled: document.getElementById('cfgEmailEnabled').checked,
      publicKey: document.getElementById('cfgEmailPubKey').value.trim(),
      serviceId: document.getElementById('cfgEmailServiceId').value.trim(),
      templateId: document.getElementById('cfgEmailTemplateId').value.trim(),
      recipientEmail: document.getElementById('cfgEmailRecipient').value.trim(),
      cooldownSeconds: parseInt(document.getElementById('cfgEmailCooldown').value, 10) || 90,
      alertOnCriticalHealth: document.getElementById('cfgEmailCritHealth').checked,
      alertOnTemperature: document.getElementById('cfgEmailTemp').checked,
      alertOnHumidity: document.getElementById('cfgEmailHumidity').checked,
      alertOnVibration: document.getElementById('cfgEmailVib').checked,
      alertOnLoad: document.getElementById('cfgEmailLoad').checked,
      alertOnSensorFault: document.getElementById('cfgEmailSensorFault').checked
    };

    window.tyravexEngine.saveSettings(newEngineSettings);
    window.tyravexEmail.saveSettings(newEmailSettings);

    // Sync unit toggle button
    pressureUnitButtons.forEach(b => {
      b.classList.toggle('active', b.dataset.unit === newEngineSettings.pressureUnit);
    });

    closeSettings();
    showToast('success', 'Configuration successfully saved to local storage.');
  });

  // Reset to Defaults
  resetDefaultsBtn.addEventListener('click', () => {
    if (confirm('Reset all parameters to recommended hardware prototype defaults?')) {
      localStorage.removeItem('tyravex_user_settings_v2');
      localStorage.removeItem('tyravex_email_settings_v2');
      window.location.reload();
    }
  });

  // EmailJS Test Button
  sendTestEmailBtn.addEventListener('click', async () => {
    emailStatusText.textContent = 'Sending test email...';
    try {
      window.tyravexEmail.settings.publicKey = document.getElementById('cfgEmailPubKey').value.trim();
      window.tyravexEmail.settings.serviceId = document.getElementById('cfgEmailServiceId').value.trim();
      window.tyravexEmail.settings.templateId = document.getElementById('cfgEmailTemplateId').value.trim();
      window.tyravexEmail.settings.recipientEmail = document.getElementById('cfgEmailRecipient').value.trim();

      const success = await window.tyravexEmail.sendTestEmail();
      if (success) {
        emailStatusText.textContent = 'Test email dispatched successfully!';
        showToast('success', 'EmailJS test email sent.');
      } else {
        emailStatusText.textContent = 'Email dispatch failed. Check console.';
      }
    } catch (err) {
      emailStatusText.textContent = `Error: ${err.message}`;
      showToast('error', err.message);
    }
  });

  // Email status listener
  window.tyravexEmail.onStatus((statusObj) => {
    if (emailStatusText) {
      emailStatusText.textContent = `Email status: ${statusObj.status} - ${statusObj.message}`;
    }
  });

  // --------------------------------------------------------------------------
  // Toast Notification System
  // --------------------------------------------------------------------------
  function showToast(type, message) {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    let iconName = 'info';
    if (type === 'success') iconName = 'check-circle';
    if (type === 'warning') iconName = 'alert-triangle';
    if (type === 'error') iconName = 'alert-circle';

    toast.innerHTML = `
      <i data-lucide="${iconName}" style="width: 18px; height: 18px; flex-shrink: 0;"></i>
      <span>${escapeHtml(message)}</span>
    `;

    container.appendChild(toast);
    if (typeof lucide !== 'undefined') lucide.createIcons();

    setTimeout(() => {
      toast.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(20px)';
      setTimeout(() => toast.remove(), 300);
    }, 4500);
  }
});
