/**
 * ==============================================================================
 * PROJECT: TYRAVEX
 * Hardware Telemetry Firmware for ESP32 Dev Module
 * ------------------------------------------------------------------------------
 * Monitored Sensors:
 * 1. Dallas DS18B20 Waterproof Temperature Sensor (OneWire on GPIO 4 with 4.7kΩ pullup)
 * 2. Waterproof Tyre Pressure Transducer (Analog ADC on GPIO 34 / 36 / 39)
 * 3. Vibration Sensor (Analog Accelerometer / Piezo or Digital Switch on GPIO 35)
 *
 * Communication:
 * - USB Serial at 115200 baud
 * - Non-blocking millis() loop
 * - Newline-delimited JSON messages matching TYRAVEX Telemetry Specification
 * ==============================================================================
 */

#include <OneWire.h>
#include <DallasTemperature.h>

// ==============================================================================
// 1. HARDWARE PIN DEFINITIONS & CONFIGURATION
// ==============================================================================

// DS18B20 OneWire Temperature Pin
// Note: Requires a 4.7kΩ pull-up resistor between ONE_WIRE_BUS and 3.3V VCC.
#define ONE_WIRE_BUS 4

// Pressure Sensor Analog Input Pin (ESP32 ADC1: GPIO 34, 35, 36, or 39 recommended)
#define PRESSURE_PIN 34

// Vibration Sensor Pin (Analog Piezo/Accelerometer or Digital switch)
#define VIBRATION_PIN 35

// Status LED (Builtin LED on ESP32 Dev Board is usually GPIO 2)
#define STATUS_LED_PIN 2

// Telemetry Sampling Interval (milliseconds)
#define TELEMETRY_INTERVAL_MS 1000

// ==============================================================================
// 2. PRESSURE SENSOR CALIBRATION PARAMETERS
// IMPORTANT HARDWARE NOTE:
// ------------------------------------------------------------------------------
// Analog pressure transducers commonly operate on 5V supply and output 0.5V - 4.5V.
// WARNING: The ESP32 ADC maximum allowable input voltage is 3.3V!
// If your transducer outputs 0.5V - 4.5V, you MUST use an external voltage divider
// (e.g. 10kΩ / 20kΩ) or signal conditioning circuit to scale the voltage into the
// 0 - 3.1V range before connecting to GPIO 34.
//
// Set PRESSURE_CALIBRATED to true ONLY after verifying your exact transducer
// transfer function and performing zero-point atmospheric calibration.
// ==============================================================================
#define PRESSURE_CALIBRATED false   // Set to true when transducer is confirmed

// Pressure Transducer Transfer Function Constants (Example: 0-100 PSI Transducer)
const float PRESSURE_V_ZERO  = 0.50; // Voltage at 0 PSI
const float PRESSURE_V_MAX   = 4.50; // Voltage at Max Rated PSI
const float PRESSURE_PSI_MAX = 100.0;// Transducer full-scale rating (PSI)

// Voltage divider ratio if dividing 4.5V down to ESP32 3.0V (V_esp = V_sensor * DIVIDER_RATIO)
// If direct 3.3V sensor with no divider, set ratio to 1.0
const float VOLTAGE_DIVIDER_RATIO = 0.667; 

// ==============================================================================
// 3. VIBRATION SENSOR CONFIGURATION
// ==============================================================================
// Set to 1 for Analog Vibration/Piezo/Accelerometer, or 0 for Digital SW-420 switch
#define VIBRATION_IS_ANALOG 1

// ADC calibration constants (ESP32 ADC has 12-bit resolution: 0 - 4095)
const float ESP32_ADC_MAX = 4095.0;
const float ESP32_VREF    = 3.3; // Nominal reference voltage

// ==============================================================================
// 4. OBJECT INSTANTIATION & GLOBALS
// ==============================================================================
OneWire oneWire(ONE_WIRE_BUS);
DallasTemperature tempSensors(&oneWire);

unsigned long lastTelemetryTime = 0;
bool ledState = false;

// ==============================================================================
// 5. HELPER FUNCTIONS
// ==============================================================================

/**
 * Reads DS18B20 temperature.
 * Returns true if valid reading obtained, false if disconnected (-127°C error).
 */
bool readTemperature(float &outTempC) {
  tempSensors.requestTemperatures();
  float temp = tempSensors.getTempCByIndex(0);

  // DEVICE_DISCONNECTED_C is -127.0f in DallasTemperature library
  if (temp <= -125.0f || temp >= 130.0f) {
    outTempC = 0.0f;
    return false;
  }

  outTempC = temp;
  return true;
}

/**
 * Reads analog pressure transducer and converts to PSI.
 * Returns true only if sensor is calibrated and reading is within plausible range.
 */
bool readTyrePressure(float &outPressurePsi) {
  if (!PRESSURE_CALIBRATED) {
    // Transducer not calibrated yet. Per specification: do not fabricate PSI values!
    return false;
  }

  int rawAdc = analogRead(PRESSURE_PIN);
  float voltageAtPin = (rawAdc / ESP32_ADC_MAX) * ESP32_VREF;
  
  // Reconstruct transducer output voltage before voltage divider
  float transducerVoltage = voltageAtPin / VOLTAGE_DIVIDER_RATIO;

  // Check if sensor is disconnected (near 0V)
  if (transducerVoltage < 0.20f) {
    return false;
  }

  // Linear transducer transfer function:
  // PSI = (V_out - V_zero) / (V_max - V_zero) * PSI_MAX
  float psi = ((transducerVoltage - PRESSURE_V_ZERO) / (PRESSURE_V_MAX - PRESSURE_V_ZERO)) * PRESSURE_PSI_MAX;

  if (psi < 0.0f) psi = 0.0f; // Clamp negative drift at zero gauge
  if (psi > 120.0f) return false; // Out of plausible tyre range

  outPressurePsi = psi;
  return true;
}

/**
 * Reads vibration intensity (measured in g units or normalized activity).
 * Takes multiple rapid samples to capture peak mechanical acceleration.
 */
bool readVibration(float &outVibrationG) {
#if VIBRATION_IS_ANALOG
  const int sampleCount = 30;
  long sumDiff = 0;
  int baseline = 2048; // Approximate 1.65V center point for analog sensors

  for (int i = 0; i < sampleCount; i++) {
    int val = analogRead(VIBRATION_PIN);
    sumDiff += abs(val - baseline);
    delayMicroseconds(100);
  }

  float avgDiff = (float)sumDiff / sampleCount;
  // Convert raw deviation to estimated acceleration in g (calibrated for standard 3.3V piezo/accelerometer)
  float gEstimate = (avgDiff / 500.0f);
  if (gEstimate < 0.05f) gEstimate = 0.05f; // Ambient vehicle baseline

  outVibrationG = gEstimate;
  return true;
#else
  // Digital vibration switch (e.g. SW-420): measure hit count in sampling window
  int hits = 0;
  for (int i = 0; i < 50; i++) {
    if (digitalRead(VIBRATION_PIN) == HIGH) {
      hits++;
    }
    delayMicroseconds(200);
  }
  // Approximate dynamic intensity from switch bounce activity
  outVibrationG = (float)hits / 10.0f;
  return true;
#endif
}

// ==============================================================================
// 6. MAIN SETUP
// ==============================================================================
void setup() {
  // Initialize USB Serial communication at 115200 baud
  Serial.begin(115200);
  while (!Serial && millis() < 3000) {
    // Wait for serial monitor or USB host connection
  }

  // Configure pins
  pinMode(STATUS_LED_PIN, OUTPUT);
  pinMode(PRESSURE_PIN, INPUT);
#if !VIBRATION_IS_ANALOG
  pinMode(VIBRATION_PIN, INPUT);
#else
  pinMode(VIBRATION_PIN, INPUT);
#endif

  // Configure ESP32 ADC attenuation for 0 - 3.3V range
  analogSetAttenuation(ADC_11db);

  // Initialize Dallas OneWire Temperature Bus
  tempSensors.begin();
  tempSensors.setResolution(10); // 10-bit resolution = ~0.25°C precision and faster read times

  // Diagnostic banner (prefixed with '#' so TYRAVEX frontend ignores as comment)
  Serial.println("# ==================================================");
  Serial.println("# TYRAVEX ESP32 Hardware Prototype Initialized");
  Serial.println("# Firmware Version: 1.0.0");
  Serial.println("# Baud Rate: 115200");
  Serial.println("# ==================================================");

  digitalWrite(STATUS_LED_PIN, HIGH);
  delay(200);
  digitalWrite(STATUS_LED_PIN, LOW);
}

// ==============================================================================
// 7. MAIN LOOP (Non-blocking millis() scheduler)
// ==============================================================================
void loop() {
  unsigned long currentMillis = millis();

  if (currentMillis - lastTelemetryTime >= TELEMETRY_INTERVAL_MS) {
    lastTelemetryTime = currentMillis;

    // Toggle heartbeat LED
    ledState = !ledState;
    digitalWrite(STATUS_LED_PIN, ledState ? HIGH : LOW);

    // 1. Read DS18B20 Temperature
    float tempReading = 0.0f;
    bool isTempValid = readTemperature(tempReading);

    // 2. Read Tyre Pressure Transducer
    float pressureReading = 0.0f;
    bool isPressureValid = readTyrePressure(pressureReading);

    // 3. Read Vibration Telemetry
    float vibrationReading = 0.0f;
    bool isVibrationValid = readVibration(vibrationReading);

    // ==========================================================================
    // 8. CONSTRUCT & TRANSMIT NEWLINE-DELIMITED JSON
    // Strict schema conforming to TYRAVEX specification:
    // {
    //   "device": "TYRAVEX",
    //   "temperature": 34.5,
    //   "pressure": null,
    //   "pressure_unit": "PSI",
    //   "pressure_valid": false,
    //   "vibration": 1.25,
    //   "vibration_unit": "g",
    //   "vibration_valid": true,
    //   "temperature_valid": true,
    //   "timestamp_ms": 12500
    // }
    // ==========================================================================

    char jsonBuffer[320];

    // Format temperature value or null
    char tempStr[16];
    if (isTempValid) {
      dtostrf(tempReading, 4, 1, tempStr);
    } else {
      strcpy(tempStr, "null");
    }

    // Format pressure value or null
    char pressureStr[16];
    if (isPressureValid) {
      dtostrf(pressureReading, 4, 1, pressureStr);
    } else {
      strcpy(pressureStr, "null");
    }

    // Format vibration value or null
    char vibrationStr[16];
    if (isVibrationValid) {
      dtostrf(vibrationReading, 4, 2, vibrationStr);
    } else {
      strcpy(vibrationStr, "null");
    }

    snprintf(jsonBuffer, sizeof(jsonBuffer),
      "{\"device\":\"TYRAVEX\","
      "\"temperature\":%s,"
      "\"pressure\":%s,"
      "\"pressure_unit\":\"PSI\","
      "\"pressure_valid\":%s,"
      "\"vibration\":%s,"
      "\"vibration_unit\":\"g\","
      "\"vibration_valid\":%s,"
      "\"temperature_valid\":%s,"
      "\"timestamp_ms\":%lu}",
      tempStr,
      pressureStr,
      isPressureValid ? "true" : "false",
      vibrationStr,
      isVibrationValid ? "true" : "false",
      isTempValid ? "true" : "false",
      currentMillis
    );

    // Transmit JSON packet terminated by newline (\n)
    Serial.println(jsonBuffer);
  }
}
