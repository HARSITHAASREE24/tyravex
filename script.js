/**
 * TYRAVEX Application Main Controller
 * Binds UI DOM, Web Serial lifecycle, Chart.js instances, Settings modal,
 * and Telemetry updates.
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
  // Chart.js Telemetry Setup
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

  // 1. Temperature Chart
  const tempCanvas = document.getElementById('tempChartCanvas').getContext('2d');
  const tempChart = new Chart(tempCanvas, {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label: 'Tyre Temp (°C)',
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
          suggestedMin: 20,
          suggestedMax: 60
        }
      }
    }
  });

  // 2. Pressure Chart
  const pressureCanvas = document.getElementById('pressureChartCanvas').getContext('2d');
  const pressureChart = new Chart(pressureCanvas, {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label: 'Tyre Pressure',
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
          title: { display: true, text: 'Pressure', color: '#64748b', font: { size: 10 } },
          suggestedMin: 20,
          suggestedMax: 40
        }
      }
    }
  });

  // 3. Vibration Chart
  const vibCanvas = document.getElementById('vibrationChartCanvas').getContext('2d');
  const vibChart = new Chart(vibCanvas, {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label: 'Vibration (g)',
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
          title: { display: true, text: 'Acceleration (g)', color: '#64748b', font: { size: 10 } },
          suggestedMin: 0,
          suggestedMax: 3
        }
      }
    }
  });

  // Empty state elements
  const tempChartEmpty = document.getElementById('tempChartEmpty');
  const pressureChartEmpty = document.getElementById('pressureChartEmpty');
  const vibChartEmpty = document.getElementById('vibrationChartEmpty');

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

    [tempChart, pressureChart, vibChart].forEach(chart => {
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

  // Listen to system priority changes
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
      const savedPref = localStorage.getItem('tyravex_theme') || 'dark';
      if (savedPref === 'system') {
        applyTheme('system', false);
      }
    });
  }

  // Initial Theme Application
  const initialThemePref = localStorage.getItem('tyravex_theme') || 'dark';
  applyTheme(initialThemePref, false);

  // --------------------------------------------------------------------------
  // Web Serial Event Handlers
  // --------------------------------------------------------------------------
  window.tyravexSerial.on('connect', (info) => {
    // If demo mode was active, turn it off
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
      showToast('info', 'DEMO MODE activated (Synthesized tyre telemetry)');
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
  // Pressure Unit Toggle Buttons
  // --------------------------------------------------------------------------
  const unitButtons = document.querySelectorAll('.unit-btn');
  unitButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      unitButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const newUnit = btn.dataset.unit;
      window.tyravexEngine.saveSettings({ pressureUnit: newUnit });
      document.getElementById('chartPressureUnitLabel').textContent = newUnit;
    });
  });

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

    // --- CARD A: Overall Tyre Health ---
    const scoreValEl = document.getElementById('healthScoreDisplay');
    const condEl = document.getElementById('healthConditionDisplay');
    const badgeEl = document.getElementById('healthStatusBadge');
    const trendEl = document.getElementById('healthTrendDisplay');
    const updatedEl = document.getElementById('healthLastUpdatedDisplay');
    const circle = document.getElementById('gaugeProgressCircle');
    const warningsBox = document.getElementById('healthWarningsBox');

    if (state.healthScore !== null) {
      scoreValEl.textContent = `${state.healthScore}%`;
      // SVG progress circle: Circumference = 2 * PI * 70 = 439.82
      const circumference = 439.82;
      const offset = circumference - (circumference * state.healthScore / 100);
      circle.style.strokeDashoffset = offset;

      if (state.healthStatus === 'GOOD') {
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
    trendEl.textContent = state.healthTrend;
    updatedEl.textContent = state.lastPacketTime
      ? new Date(state.lastPacketTime).toLocaleTimeString()
      : 'Never';

    // Warnings list
    if (state.activeWarnings && state.activeWarnings.length > 0) {
      warningsBox.innerHTML = `<strong>Telemetry Warnings:</strong><br>• ` + state.activeWarnings.join('<br>• ');
      warningsBox.classList.add('active');
    } else {
      warningsBox.classList.remove('active');
    }

    // --- CARD B: Tyre Temperature ---
    const tempDisp = document.getElementById('tempCurrentDisplay');
    const tempBadge = document.getElementById('tempStatusBadge');
    const tempMin = document.getElementById('tempMinDisplay');
    const tempMax = document.getElementById('tempMaxDisplay');
    const tempTrend = document.getElementById('tempTrendDisplay');

    if (state.temperatureValid && state.temperature !== null) {
      tempDisp.textContent = state.temperature.toFixed(1);
      tempMin.textContent = `${state.tempMin.toFixed(1)} °C`;
      tempMax.textContent = `${state.tempMax.toFixed(1)} °C`;
      tempTrend.textContent = state.healthTrend;

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

    // --- CARD C: Tyre Pressure ---
    const pressDisp = document.getElementById('pressureCurrentDisplay');
    const pressUnitEl = document.getElementById('pressureCurrentUnit');
    const pressTargetEl = document.getElementById('pressureTargetDisplay');
    const pressDevEl = document.getElementById('pressureDeviationDisplay');
    const pressStatusEl = document.getElementById('pressureStatusText');
    const pressSensorEl = document.getElementById('pressureSensorState');

    const curUnit = settings.pressureUnit;
    pressUnitEl.textContent = curUnit;
    
    // Convert target to user's unit
    const convertedTarget = TyravexDashboardEngine.convertPressure(settings.targetPressure, 'PSI', curUnit);
    pressTargetEl.textContent = `${convertedTarget.toFixed(1)} ${curUnit}`;

    if (state.pressureValid && state.pressure !== null) {
      const convertedVal = TyravexDashboardEngine.convertPressure(state.pressure, 'PSI', curUnit);
      pressDisp.textContent = convertedVal.toFixed(1);
      
      const delta = convertedVal - convertedTarget;
      const sign = delta >= 0 ? '+' : '';
      pressDevEl.textContent = `${sign}${delta.toFixed(1)} ${curUnit}`;

      const devPct = Math.abs(state.pressure - settings.targetPressure) / settings.targetPressure * 100;
      if (devPct > settings.pressureToleranceCritPct) {
        pressStatusEl.textContent = delta < 0 ? 'CRITICAL LOW' : 'CRITICAL HIGH';
        pressSensorEl.textContent = 'TRANSDUCER OK';
      } else if (devPct > settings.pressureToleranceWarnPct) {
        pressStatusEl.textContent = delta < 0 ? 'LOW PRESSURE' : 'HIGH PRESSURE';
        pressSensorEl.textContent = 'TRANSDUCER OK';
      } else {
        pressStatusEl.textContent = 'OPTIMAL';
        pressSensorEl.textContent = 'TRANSDUCER OK';
      }
    } else {
      pressDisp.textContent = '--';
      pressDevEl.textContent = '--';
      pressStatusEl.textContent = 'RAW / UNCALIBRATED';
      pressSensorEl.textContent = 'UNCALIBRATED';
    }

    // --- CARD D: Vibration Monitoring ---
    const vibDisp = document.getElementById('vibrationCurrentDisplay');
    const vibUnitEl = document.getElementById('vibrationCurrentUnit');
    const vibBadge = document.getElementById('vibrationStatusBadge');
    const vibPeakEl = document.getElementById('vibrationPeakDisplay');
    const vibAbnormalEl = document.getElementById('vibrationAbnormalDisplay');
    const vibStateEl = document.getElementById('vibrationStateDisplay');

    vibUnitEl.textContent = state.vibrationUnit || 'g';

    if (state.vibrationValid && state.vibration !== null) {
      vibDisp.textContent = state.vibration.toFixed(2);
      vibPeakEl.textContent = `${state.peakVibration.toFixed(2)} ${state.vibrationUnit}`;
      vibAbnormalEl.textContent = state.abnormalVibrationCount;

      if (state.vibration >= settings.vibrationCritG) {
        vibBadge.textContent = 'CRITICAL';
        vibBadge.className = 'card-status-badge critical';
        vibStateEl.textContent = 'Severe Vibration Spike';
      } else if (state.vibration >= settings.vibrationWarnG) {
        vibBadge.textContent = 'ELEVATED';
        vibBadge.className = 'card-status-badge warning';
        vibStateEl.textContent = 'Moderate Vibration';
      } else {
        vibBadge.textContent = 'NORMAL';
        vibBadge.className = 'card-status-badge good';
        vibStateEl.textContent = 'Nominal Running';
      }
    } else {
      vibDisp.textContent = '--';
      vibBadge.textContent = 'NO DATA';
      vibBadge.className = 'card-status-badge';
      vibStateEl.textContent = 'Awaiting Sensor Telemetry';
    }

    // --- CARD E: Road Impact Analysis ---
    const impactCountEl = document.getElementById('impactCountDisplay');
    const impactPeakEl = document.getElementById('impactPeakDisplay');
    const roadCondBadge = document.getElementById('roadConditionBadge');
    const roadProfileEl = document.getElementById('roadProfileDisplay');
    const impactThreshEl = document.getElementById('impactThresholdDisplay');

    impactCountEl.textContent = state.impactEvents;
    impactPeakEl.textContent = state.peakImpact > 0 ? `${state.peakImpact.toFixed(2)} g` : '-- g';
    impactThreshEl.textContent = `≥ ${settings.impactThresholdG.toFixed(1)} g`;
    roadCondBadge.textContent = state.roadCondition;
    roadCondBadge.className = `card-status-badge ${state.roadCondition.toLowerCase()}`;
    roadProfileEl.textContent = state.roadCondition === 'SMOOTH'
      ? 'Smooth Asphalt / Highway'
      : state.roadCondition === 'MODERATE'
      ? 'Typical Urban / Minor Bumps'
      : state.roadCondition === 'ROUGH'
      ? 'Rough Surface / Potholes'
      : 'Insufficient Data';

    // --- CARD F: Sensor Health ---
    const commBadge = document.getElementById('commStatusBadge');
    const pillEsp32 = document.getElementById('sensorEsp32Pill');
    const pillTemp = document.getElementById('sensorTempPill');
    const pillPress = document.getElementById('sensorPressurePill');
    const pillVib = document.getElementById('sensorVibrationPill');
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

    // Temp sensor probe
    if (state.temperatureValid) {
      pillTemp.textContent = 'OPERATIONAL';
      pillTemp.className = 'sensor-pill ok';
    } else if (state.isConnected) {
      pillTemp.textContent = 'FAULT / DISCONNECTED';
      pillTemp.className = 'sensor-pill error';
    } else {
      pillTemp.textContent = 'NO DATA';
      pillTemp.className = 'sensor-pill none';
    }

    // Pressure probe
    if (state.pressureValid) {
      pillPress.textContent = 'CALIBRATED';
      pillPress.className = 'sensor-pill ok';
    } else {
      pillPress.textContent = 'UNCALIBRATED';
      pillPress.className = 'sensor-pill uncalibrated';
    }

    // Vibration probe
    if (state.vibrationValid) {
      pillVib.textContent = 'OPERATIONAL';
      pillVib.className = 'sensor-pill ok';
    } else if (state.isConnected) {
      pillVib.textContent = 'FAULT';
      pillVib.className = 'sensor-pill error';
    } else {
      pillVib.textContent = 'NO DATA';
      pillVib.className = 'sensor-pill none';
    }

    // --- CARD G: Live Charts Update ---
    if (chartData.labels.length > 0) {
      tempChartEmpty.classList.add('hidden');
      pressureChartEmpty.classList.add('hidden');
      vibChartEmpty.classList.add('hidden');

      tempChart.data.labels = chartData.labels;
      tempChart.data.datasets[0].data = chartData.temperature;
      tempChart.update('none');

      pressureChart.data.labels = chartData.labels;
      pressureChart.data.datasets[0].label = `Tyre Pressure (${curUnit})`;
      pressureChart.data.datasets[0].data = chartData.pressure;
      pressureChart.update('none');

      vibChart.data.labels = chartData.labels;
      vibChart.data.datasets[0].data = chartData.vibration;
      vibChart.update('none');
    } else {
      tempChartEmpty.classList.remove('hidden');
      pressureChartEmpty.classList.remove('hidden');
      vibChartEmpty.classList.remove('hidden');
    }

    // --- CARD H: Event Log Table Update ---
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
          <td colspan="7" class="table-empty-row">
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
        <td>${item.pressure}</td>
        <td>${item.vibration}</td>
        <td>${escapeHtml(item.description)}</td>
      </tr>
    `).join('');
  }

  function escapeHtml(str) {
    return str
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

    // Populate fields
    document.getElementById('cfgTargetPressure').value = s.targetPressure;
    document.getElementById('cfgPressureUnit').value = s.pressureUnit;
    document.getElementById('cfgPressWarnPct').value = s.pressureToleranceWarnPct;
    document.getElementById('cfgPressCritPct').value = s.pressureToleranceCritPct;
    document.getElementById('cfgTempWarn').value = s.tempWarnC;
    document.getElementById('cfgTempCrit').value = s.tempCritC;
    document.getElementById('cfgVibWarn').value = s.vibrationWarnG;
    document.getElementById('cfgImpactThresh').value = s.impactThresholdG;
    document.getElementById('cfgWeightPress').value = s.weightPressure;
    document.getElementById('cfgWeightTemp').value = s.weightTemp;
    document.getElementById('cfgWeightVib').value = s.weightVibration;
    document.getElementById('cfgChartPoints').value = s.chartHistoryLength;

    // EmailJS
    document.getElementById('cfgEmailEnabled').checked = es.enabled;
    document.getElementById('cfgEmailPubKey').value = es.publicKey || '';
    document.getElementById('cfgEmailServiceId').value = es.serviceId || '';
    document.getElementById('cfgEmailTemplateId').value = es.templateId || '';
    document.getElementById('cfgEmailRecipient').value = es.recipientEmail || '';
    document.getElementById('cfgEmailCooldown').value = es.cooldownSeconds || 90;
    document.getElementById('cfgEmailCritHealth').checked = es.alertOnCriticalHealth;
    document.getElementById('cfgEmailTemp').checked = es.alertOnTemperature;
    document.getElementById('cfgEmailPress').checked = es.alertOnPressure;
    document.getElementById('cfgEmailVib').checked = es.alertOnVibration;

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
      targetPressure: parseFloat(document.getElementById('cfgTargetPressure').value),
      pressureUnit: document.getElementById('cfgPressureUnit').value,
      pressureToleranceWarnPct: parseFloat(document.getElementById('cfgPressWarnPct').value),
      pressureToleranceCritPct: parseFloat(document.getElementById('cfgPressCritPct').value),
      tempWarnC: parseFloat(document.getElementById('cfgTempWarn').value),
      tempCritC: parseFloat(document.getElementById('cfgTempCrit').value),
      vibrationWarnG: parseFloat(document.getElementById('cfgVibWarn').value),
      impactThresholdG: parseFloat(document.getElementById('cfgImpactThresh').value),
      weightPressure: parseInt(document.getElementById('cfgWeightPress').value, 10),
      weightTemp: parseInt(document.getElementById('cfgWeightTemp').value, 10),
      weightVibration: parseInt(document.getElementById('cfgWeightVib').value, 10),
      chartHistoryLength: parseInt(document.getElementById('cfgChartPoints').value, 10)
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
      alertOnPressure: document.getElementById('cfgEmailPress').checked,
      alertOnVibration: document.getElementById('cfgEmailVib').checked
    };

    window.tyravexEngine.saveSettings(newEngineSettings);
    window.tyravexEmail.saveSettings(newEmailSettings);

    // Sync unit toggle button in header
    unitButtons.forEach(b => {
      b.classList.toggle('active', b.dataset.unit === newEngineSettings.pressureUnit);
    });

    closeSettings();
    showToast('success', 'Configuration successfully saved to local storage.');
  });

  // Reset to Defaults
  resetDefaultsBtn.addEventListener('click', () => {
    if (confirm('Reset all parameters to recommended automotive prototype defaults?')) {
      localStorage.removeItem('tyravex_user_settings');
      localStorage.removeItem('tyravex_email_settings');
      window.location.reload();
    }
  });

  // EmailJS Test Button
  sendTestEmailBtn.addEventListener('click', async () => {
    emailStatusText.textContent = 'Sending test email...';
    try {
      // Temporarily grab current inputs from modal for the test
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
