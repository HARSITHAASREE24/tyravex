/**
 * ==============================================================================
 * PROJECT: TYRAVEX
 * Hardware Telemetry Firmware for ESP32 Dev Module
 * Hardware Configuration:
 * 1. DHT11 - Ambient Temperature (°C) & Relative Humidity (%RH) on GPIO 4
 * 2. BMP280 - Tire Pressure Sensor via I2C (SDA GPIO 21, SCL GPIO 22)
 * 3. Vibration Sensor Module - Analog Output (AO GPIO 34) & Digital Output (DO GPIO 35)
 * 4. 10 kg Load Cell + HX711 Load Cell Amplifier Module (DT GPIO 18, SCK GPIO 19)
 *
 * Communication:
 * - USB Serial at 115200 baud
 * - Non-blocking millis() loop
 * - Newline-delimited JSON messages matching TYRAVEX Telemetry Specification
 * - Interactive USB Serial calibration commands:
 *     "TARE"           -> Zeroes the load cell and stores offset in ESP32 NVS
 *     "CAL:<weight_kg>"-> Calibrates with known weight (e.g. CAL:1.0) and saves scale
 *     "RESET_CAL"      -> Resets calibration factors to default factory scale
 * ==============================================================================
 */

#include <Wire.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_BMP280.h>
#include <DHT.h>
#include "HX711.h"
#include <Preferences.h>

// ==============================================================================
// 1. HARDWARE PIN DEFINITIONS & CONFIGURATION
// ==============================================================================

// DHT11 Ambient Temperature & Humidity Sensor Pin
#define DHT_PIN 4
#define DHT_TYPE DHT11

// BMP280 Pressure Sensor I2C Pins
#define BMP280_SDA_PIN 21
#define BMP280_SCL_PIN 22
#define BMP280_I2C_ADDR_PRIMARY   0x76
#define BMP280_I2C_ADDR_SECONDARY 0x77

// Vibration Sensor Module Pins
#define VIBRATION_AO_PIN 34
#define VIBRATION_DO_PIN 35

// HX711 Load Cell Amplifier Module Pins (Configured to GPIO 18 and 19)
#define HX711_DT_PIN  18   // DT / DOUT from HX711 to ESP32
#define HX711_SCK_PIN 19   // SCK / CLK from ESP32 to HX711

// Status Indicator LED (GPIO 2 is onboard LED on standard ESP32 boards)
#define STATUS_LED_PIN 2

// Telemetry Intervals
#define TELEMETRY_INTERVAL_MS 1000  // Main JSON transmission interval (1 Hz)
#define DHT_SAMPLE_INTERVAL_MS 2000 // DHT11 minimum sample interval (2 Hz)

// Default Load Cell Calibration Constants (for 10 kg single-point load cell)
// Raw ADC unloaded baseline is ~24,000 - 25,000 counts; 1 kg applied load produces ~21,500 count delta
const float DEFAULT_LOAD_SCALE_FACTOR = 21500.0f;

// ==============================================================================
// 2. GLOBAL SENSOR OBJECTS & STATE
// ==============================================================================
DHT dht(DHT_PIN, DHT_TYPE);
Adafruit_BMP280 bmp280;
HX711 scale;
Preferences prefs;

// Sensor Health & Initialization Flags
bool bmp280Initialized = false;
bool hx711Initialized = false;
bool loadCalibrated = false;

// Calibration Parameters for 10 kg Load Cell
float loadScaleFactor = DEFAULT_LOAD_SCALE_FACTOR; // Scale factor: (raw - offset) / kg
long  loadTareOffset  = 24500;                    // Nominal unloaded zero-point offset

// Interrupt-safe vibration event counter for Digital Output (DO)
volatile unsigned long vibrationInterruptCount = 0;

void IRAM_ATTR onVibrationDOTrigger() {
  vibrationInterruptCount++;
}

// Cached readings for non-blocking sensors
float cachedTemperature = 0.0f;
float cachedHumidity = 0.0f;
bool  cachedDhtValid = false;
unsigned long lastDhtReadTime = 0;

unsigned long lastTelemetryTime = 0;
bool ledHeartbeat = false;

// Serial Command Line Buffer
String serialCommandBuffer = "";

// ==============================================================================
// 3. LOAD CELL CALIBRATION & STORAGE HELPERS
// ==============================================================================
void loadCalibrationFromNVS() {
  prefs.begin("tyravex", false);
  long storedTare = prefs.getLong("tare", 0);
  float storedScale = prefs.getFloat("scale", 0.0f);
  bool storedCal = prefs.getBool("calibrated", false);
  prefs.end();

  if (storedCal && abs(storedScale) > 100.0f) {
    loadTareOffset = storedTare;
    loadScaleFactor = storedScale;
    loadCalibrated = true;
    scale.set_offset(loadTareOffset);
    scale.set_scale(loadScaleFactor);
    Serial.printf("# [TYRAVEX NVS] Loaded custom calibration: Offset=%ld, Scale=%.1f\n", loadTareOffset, loadScaleFactor);
  } else {
    // Perform automatic live tare on boot if no custom calibration in NVS
    Serial.println("# [TYRAVEX] Performing initial tare offset calculation...");
    scale.set_scale(1.0f);
    scale.tare(10);
    loadTareOffset = scale.get_offset();
    loadScaleFactor = DEFAULT_LOAD_SCALE_FACTOR;
    scale.set_scale(loadScaleFactor);
    loadCalibrated = true; // Calibrated using default factory transfer curve
    Serial.printf("# [TYRAVEX] Initial tare complete. Zero offset: %ld, Default scale factor: %.1f\n", loadTareOffset, loadScaleFactor);
  }
}

void saveCalibrationToNVS(long offset, float factor, bool calibrated) {
  prefs.begin("tyravex", false);
  prefs.putLong("tare", offset);
  prefs.putFloat("scale", factor);
  prefs.putBool("calibrated", calibrated);
  prefs.end();
  loadTareOffset = offset;
  loadScaleFactor = factor;
  loadCalibrated = calibrated;
}

// ==============================================================================
// 4. SENSOR READ FUNCTIONS
// ==============================================================================

/**
 * Reads DHT11 Temperature and Humidity with non-blocking rate limiter.
 */
void updateDHT11() {
  unsigned long now = millis();
  if (now - lastDhtReadTime < DHT_SAMPLE_INTERVAL_MS && lastDhtReadTime != 0) {
    return;
  }
  lastDhtReadTime = now;

  float h = dht.readHumidity();
  float t = dht.readTemperature(); // in Celsius

  if (isnan(h) || isnan(t) || t < -20.0f || t > 80.0f || h < 0.0f || h > 100.0f) {
    cachedDhtValid = false;
    cachedTemperature = 0.0f;
    cachedHumidity = 0.0f;
  } else {
    cachedDhtValid = true;
    cachedTemperature = t;
    cachedHumidity = h;
  }
}

/**
 * Reads Pressure Sensor in hPa.
 */
bool readTirePressure(float &outPressureHpa) {
  if (!bmp280Initialized) {
    return false;
  }

  float pressure = bmp280.readPressure(); // in Pa
  if (isnan(pressure) || pressure <= 0.0f) {
    return false;
  }

  float hpa = pressure / 100.0f;
  if (hpa < 300.0f || hpa > 1300.0f) {
    return false;
  }

  outPressureHpa = hpa;
  return true;
}

/**
 * Reads Vibration Sensor (AO analog ADC and DO digital status).
 */
void readVibrationSensor(int &outRawAnalog, int &outDigitalVal, unsigned long &outEventCount) {
  const int numSamples = 16;
  int peakAdc = 0;

  for (int i = 0; i < numSamples; i++) {
    int val = analogRead(VIBRATION_AO_PIN);
    if (val > peakAdc) {
      peakAdc = val;
    }
    delayMicroseconds(50);
  }

  outRawAnalog = peakAdc;
  outDigitalVal = digitalRead(VIBRATION_DO_PIN);
  outEventCount = vibrationInterruptCount;
}

/**
 * Reads Suspension / Tire Load from HX711 and 10 kg Load Cell.
 * Returns load in kg and raw ADC value.
 */
bool readSuspensionLoad(float &outLoadKg, long &outRawUnits, bool &outCalibrated) {
  outCalibrated = loadCalibrated;

  if (!hx711Initialized || !scale.is_ready()) {
    outLoadKg = 0.0f;
    outRawUnits = 0;
    return false;
  }

  // Get raw reading (average of 3 samples)
  long raw = scale.read_average(3);
  outRawUnits = raw;

  // Convert raw value using tare offset and scale factor
  // load = (raw - offset) / scale_factor
  float computedKg = 0.0f;
  if (abs(loadScaleFactor) > 0.01f) {
    computedKg = (float)(raw - loadTareOffset) / loadScaleFactor;
  } else {
    computedKg = scale.get_units(3);
  }

  // Clamp small negative drift near zero
  if (computedKg < 0.0f && computedKg > -0.05f) {
    computedKg = 0.0f;
  }

  // Mechanical sanity check
  if (computedKg < -2.0f || computedKg > 25.0f) {
    return false;
  }

  outLoadKg = computedKg;
  return true;
}

// ==============================================================================
// 5. SERIAL COMMAND PARSER FOR LOAD CELL CALIBRATION
// ==============================================================================
void handleSerialCommands() {
  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      serialCommandBuffer.trim();
      if (serialCommandBuffer.length() > 0) {
        processCommand(serialCommandBuffer);
        serialCommandBuffer = "";
      }
    } else {
      if (serialCommandBuffer.length() < 64) {
        serialCommandBuffer += c;
      }
    }
  }
}

void processCommand(String cmd) {
  cmd.toUpperCase();

  // 1. Tare Command: "TARE"
  if (cmd == "TARE") {
    if (scale.is_ready()) {
      Serial.println("# [CALIBRATION] Executing unloaded tare (averaging 15 samples)...");
      scale.set_scale(1.0f);
      scale.tare(15);
      long newOffset = scale.get_offset();
      scale.set_scale(loadScaleFactor);
      saveCalibrationToNVS(newOffset, loadScaleFactor, true);
      Serial.printf("# [CALIBRATION] Tare complete! Stored zero offset: %ld\n", newOffset);
    } else {
      Serial.println("# [CALIBRATION ERROR] HX711 not ready to tare.");
    }
    return;
  }

  // 2. Calibrate Command: "CAL:<known_weight_kg>" e.g. "CAL:1.0" or "CAL:5.0"
  if (cmd.startsWith("CAL:")) {
    String weightStr = cmd.substring(4);
    float knownWeight = weightStr.toFloat();

    if (knownWeight <= 0.05f || knownWeight > 15.0f) {
      Serial.println("# [CALIBRATION ERROR] Known weight must be between 0.1 kg and 10.0 kg.");
      return;
    }

    if (scale.is_ready()) {
      Serial.printf("# [CALIBRATION] Calibrating with reference weight: %.3f kg...\n", knownWeight);
      long rawReading = scale.read_average(15);
      long diff = rawReading - loadTareOffset;

      if (abs(diff) < 500) {
        Serial.println("# [CALIBRATION ERROR] Measured delta too small. Ensure reference weight is securely placed.");
        return;
      }

      float calculatedFactor = (float)diff / knownWeight;
      loadScaleFactor = calculatedFactor;
      scale.set_scale(calculatedFactor);
      saveCalibrationToNVS(loadTareOffset, calculatedFactor, true);

      Serial.printf("# [CALIBRATION SUCCESS] Scale factor set to %.3f. Calibration stored in NVS.\n", calculatedFactor);
    } else {
      Serial.println("# [CALIBRATION ERROR] HX711 not responding.");
    }
    return;
  }

  // 3. Reset Calibration: "RESET_CAL"
  if (cmd == "RESET_CAL") {
    saveCalibrationToNVS(24500, DEFAULT_LOAD_SCALE_FACTOR, false);
    scale.set_scale(DEFAULT_LOAD_SCALE_FACTOR);
    scale.set_offset(24500);
    Serial.println("# [CALIBRATION] Reset calibration to default factory profile.");
    return;
  }

  Serial.printf("# [SERIAL] Received: %s\n", cmd.c_str());
}

// ==============================================================================
// 6. MAIN SETUP
// ==============================================================================
void setup() {
  Serial.begin(115200);
  while (!Serial && millis() < 2500) {
    // Wait for USB Serial connection
  }

  pinMode(STATUS_LED_PIN, OUTPUT);
  digitalWrite(STATUS_LED_PIN, HIGH);

  // Configure Vibration Sensor Pins
  pinMode(VIBRATION_AO_PIN, INPUT);
  pinMode(VIBRATION_DO_PIN, INPUT);

  // Configure ESP32 ADC attenuation for full 0 - 3.3V range
  analogSetAttenuation(ADC_11db);

  // Attach interrupt on Vibration DO pin
  attachInterrupt(digitalPinToInterrupt(VIBRATION_DO_PIN), onVibrationDOTrigger, RISING);

  // Initialize I2C for Pressure Sensor
  Wire.begin(BMP280_SDA_PIN, BMP280_SCL_PIN);

  // Diagnostic Header
  Serial.println("# ==================================================");
  Serial.println("# TYRAVEX ESP32 Hardware Telemetry System");
  Serial.println("# Sensors: DHT11 (GPIO 4), BMP280 (I2C 21/22)");
  Serial.println("# Vibration (AO 34, DO 35), HX711 (DT 18, SCK 19)");
  Serial.println("# Baud Rate: 115200");
  Serial.println("# ==================================================");

  // 1. Initialize DHT11
  dht.begin();
  Serial.println("# [INIT] DHT11 Temperature & Humidity Sensor initialized on GPIO 4.");

  // 2. Initialize Pressure Sensor (BMP280)
  if (bmp280.begin(BMP280_I2C_ADDR_PRIMARY)) {
    bmp280Initialized = true;
    Serial.println("# [INIT] Tire Pressure Sensor (BMP280) initialized at 0x76.");
  } else if (bmp280.begin(BMP280_I2C_ADDR_SECONDARY)) {
    bmp280Initialized = true;
    Serial.println("# [INIT] Tire Pressure Sensor (BMP280) initialized at 0x77.");
  } else {
    bmp280Initialized = false;
    Serial.println("# [INIT WARNING] BMP280 not detected on I2C bus (Check SDA/SCL pins 21/22).");
  }

  // 3. Initialize HX711 Load Cell Amplifier on GPIO 18 (DT) and GPIO 19 (SCK)
  scale.begin(HX711_DT_PIN, HX711_SCK_PIN);
  delay(150);
  if (scale.is_ready()) {
    hx711Initialized = true;
    Serial.println("# [INIT] HX711 Load Cell Amplifier initialized on DT=18, SCK=19.");
    loadCalibrationFromNVS();
  } else {
    hx711Initialized = false;
    Serial.println("# [INIT WARNING] HX711 not responding on pins DT=18, SCK=19. Check wiring!");
  }

  digitalWrite(STATUS_LED_PIN, LOW);
}

// ==============================================================================
// 7. MAIN LOOP (Non-blocking millis() scheduler)
// ==============================================================================
void loop() {
  handleSerialCommands();
  updateDHT11();

  unsigned long currentMillis = millis();
  if (currentMillis - lastTelemetryTime >= TELEMETRY_INTERVAL_MS) {
    lastTelemetryTime = currentMillis;

    // Toggle heartbeat LED
    ledHeartbeat = !ledHeartbeat;
    digitalWrite(STATUS_LED_PIN, ledHeartbeat ? HIGH : LOW);

    // 1. DHT11 Values
    bool dht11Valid = cachedDhtValid;
    float tempC = cachedTemperature;
    float humidityPct = cachedHumidity;

    // 2. Tire Pressure (hPa)
    float tirePressureHpa = 0.0f;
    bool bmp280Valid = readTirePressure(tirePressureHpa);

    // 3. Vibration Sensor (AO & DO)
    int vibAnalogRaw = 0;
    int vibDigital = 0;
    unsigned long vibEvents = 0;
    readVibrationSensor(vibAnalogRaw, vibDigital, vibEvents);
    bool vibAnalogValid = true;
    bool vibDigitalValid = true;

    // 4. HX711 Suspension / Tire Load (kg and raw counts)
    float loadKg = 0.0f;
    long loadRaw = 0;
    bool isCalibrated = false;
    bool hx711Valid = readSuspensionLoad(loadKg, loadRaw, isCalibrated);

    // ==========================================================================
    // 8. FORMAT EXACT TYRAVEX TELEMETRY JSON
    // ==========================================================================
    char jsonBuffer[420];

    char tempStr[16];
    if (dht11Valid) {
      dtostrf(tempC, 4, 1, tempStr);
    } else {
      strcpy(tempStr, "null");
    }

    char humStr[16];
    if (dht11Valid) {
      dtostrf(humidityPct, 4, 1, humStr);
    } else {
      strcpy(humStr, "null");
    }

    char pressStr[16];
    if (bmp280Valid) {
      dtostrf(tirePressureHpa, 5, 1, pressStr);
    } else {
      strcpy(pressStr, "null");
    }

    char loadStr[16];
    if (hx711Valid && isCalibrated) {
      dtostrf(loadKg, 5, 2, loadStr);
    } else {
      strcpy(loadStr, "null");
    }

    snprintf(jsonBuffer, sizeof(jsonBuffer),
      "{\"device\":\"TYRAVEX\","
      "\"temperature_c\":%s,"
      "\"humidity_percent\":%s,"
      "\"tire_pressure_hpa\":%s,"
      "\"atmospheric_pressure_hpa\":%s,"
      "\"vibration_analog_raw\":%d,"
      "\"vibration_digital\":%d,"
      "\"vibration_event_count\":%lu,"
      "\"load_kg\":%s,"
      "\"load_raw\":%ld,"
      "\"load_calibrated\":%s,"
      "\"dht11_valid\":%s,"
      "\"bmp280_valid\":%s,"
      "\"vibration_analog_valid\":%s,"
      "\"vibration_digital_valid\":%s,"
      "\"hx711_valid\":%s,"
      "\"timestamp_ms\":%lu}",
      tempStr,
      humStr,
      pressStr,
      pressStr, // Backward compatibility for both tire_pressure_hpa and atmospheric_pressure_hpa
      vibAnalogRaw,
      vibDigital,
      vibEvents,
      loadStr,
      loadRaw,
      loadCalibrated ? "true" : "false",
      dht11Valid ? "true" : "false",
      bmp280Valid ? "true" : "false",
      vibAnalogValid ? "true" : "false",
      vibDigitalValid ? "true" : "false",
      hx711Valid ? "true" : "false",
      currentMillis
    );

    // Transmit one JSON line per telemetry interval
    Serial.println(jsonBuffer);
  }
}
