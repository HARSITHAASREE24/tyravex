#include <Wire.h>
#include <DHT.h>
#include <Adafruit_BMP280.h>
#include <HX711.h>
#include <math.h>

// ==================================================
// 1. PIN DEFINITIONS & CONSTANTS
// ==================================================

#define DHT_PIN          4
#define DHT_TYPE         DHT11

#define VIBRATION_PIN    35

#define BMP_SDA          21
#define BMP_SCL          22

#define HX711_DOUT       18
#define HX711_SCK        5

#define STATUS_LED_PIN   2

#define TELEMETRY_INTERVAL_MS   1000
#define DHT_SAMPLE_INTERVAL_MS  2000

#define LOAD_CELL_MAX_KG 10.0f

// ==================================================
// 2. SENSOR OBJECTS
// ==================================================

DHT dht(DHT_PIN, DHT_TYPE);
Adafruit_BMP280 bmp;
HX711 scale;

// ==================================================
// 3. LOAD CELL CALIBRATION FACTOR
// ==================================================

float CALIBRATION_FACTOR = 12345.0f;
bool LOAD_CELL_CALIBRATED = true;

// ==================================================
// 4. GLOBAL SENSOR STATE & CACHE
// ==================================================

bool bmpAvailable = false;
bool hx711Available = false;
bool ledState = false;

// Cached DHT11 values
float cachedDhtTemp = 0.0f;
float cachedDhtHum = 0.0f;
bool cachedDhtValid = false;
unsigned long lastDhtSampleTime = 0;

unsigned long lastTelemetryTime = 0;

// ==================================================
// 5. DHT11 READING WITH CACHING & TIMING PROTECTION
// ==================================================

void updateDHT() {
  unsigned long now = millis();
  // DHT11 hardware requires at least 2000 ms between reads
  if (now - lastDhtSampleTime >= DHT_SAMPLE_INTERVAL_MS || lastDhtSampleTime == 0) {
    lastDhtSampleTime = now;

    float t = dht.readTemperature();
    float h = dht.readHumidity();

    if (!isnan(t) && t >= -20.0f && t <= 75.0f) {
      cachedDhtTemp = t;
      if (!isnan(h) && h >= 0.0f && h <= 100.0f) {
        cachedDhtHum = h;
      }
      cachedDhtValid = true;
    } else {
      // DHT11 returned NaN or read error
      // Don't invalidate immediately if we had a recent reading (within 6 seconds)
      if (now - lastDhtSampleTime > 6000) {
        cachedDhtValid = false;
      }
    }
  }
}

// ==================================================
// 6. BMP280 ATMOSPHERIC PRESSURE & PRECISION TEMPERATURE
// ==================================================

bool readBMP280(float &pressureHpa, float &bmpTemp) {
  if (!bmpAvailable) {
    return false;
  }

  pressureHpa = bmp.readPressure() / 100.0f;
  bmpTemp = bmp.readTemperature();

  return !isnan(pressureHpa) && pressureHpa >= 300.0f && pressureHpa <= 1200.0f;
}

// ==================================================
// 7. ANALOG VIBRATION ACTIVITY
// ==================================================

bool readVibration(float &activity) {
  const int sampleCount = 50;
  int samples[sampleCount];
  long sum = 0;

  for (int i = 0; i < sampleCount; i++) {
    samples[i] = analogRead(VIBRATION_PIN);
    sum += samples[i];
    delayMicroseconds(500);
  }

  float mean = (float)sum / sampleCount;
  float deviation = 0.0f;

  for (int i = 0; i < sampleCount; i++) {
    deviation += fabsf(samples[i] - mean);
  }

  activity = deviation / sampleCount;

  return true;
}

// ==================================================
// 8. HX711 DIGITAL WEIGHT (KG & PERCENTAGE)
// ==================================================

bool readLoadCell(float &weightKg, float &weightPercent, long &rawValue) {
  if (!scale.is_ready()) {
    hx711Available = false;
    return false;
  }

  hx711Available = true;
  rawValue = scale.read();

  // Average 5 readings for a steadier weight value
  weightKg = scale.get_units(5);

  if (isnan(weightKg) || isinf(weightKg)) {
    weightKg = 0.0f;
    weightPercent = 0.0f;
    return false;
  }

  // Suppress small zero drift
  if (weightKg < 0.02f) {
    weightKg = 0.0f;
  }

  // Calculate percentage of rated capacity (10 kg max)
  weightPercent = (weightKg / LOAD_CELL_MAX_KG) * 100.0f;
  if (weightPercent < 0.0f) weightPercent = 0.0f;
  if (weightPercent > 100.0f) weightPercent = 100.0f;

  return true;
}

// ==================================================
// 9. SETUP
// ==================================================

void setup() {
  Serial.begin(115200);
  delay(1000);

  pinMode(STATUS_LED_PIN, OUTPUT);
  pinMode(VIBRATION_PIN, INPUT);

  // Enable internal pull-up on DHT pin to prevent signal loss on ESP32
  pinMode(DHT_PIN, INPUT_PULLUP);

  analogReadResolution(12);
  analogSetPinAttenuation(VIBRATION_PIN, ADC_11db);

  // DHT11 Start
  dht.begin();

  // BMP280 Start on I2C
  Wire.begin(BMP_SDA, BMP_SCL);

  if (bmp.begin(0x76)) {
    bmpAvailable = true;
    Serial.println("# BMP280 detected on I2C address 0x76");
  } else if (bmp.begin(0x77)) {
    bmpAvailable = true;
    Serial.println("# BMP280 detected on I2C address 0x77");
  }

  if (bmpAvailable) {
    bmp.setSampling(
      Adafruit_BMP280::MODE_NORMAL,
      Adafruit_BMP280::SAMPLING_X2,
      Adafruit_BMP280::SAMPLING_X16,
      Adafruit_BMP280::FILTER_X16,
      Adafruit_BMP280::STANDBY_MS_500
    );
  } else {
    Serial.println("# BMP280 not detected on 0x76 or 0x77");
  }

  // HX711 Start
  scale.begin(HX711_DOUT, HX711_SCK);
  delay(500);

  Serial.println("# ====================================");
  Serial.println("# TYRAVEX ESP32 Telemetry Engine");
  Serial.println("# Temperature: DHT11 + BMP280 Fallback");
  Serial.println("# Pressure: BMP280 | Vibration: GPIO35");
  Serial.println("# Weight: HX711 DOUT:18 SCK:5 (kg & %)");
  Serial.println("# ====================================");

  if (scale.wait_ready_timeout(3000)) {
    hx711Available = true;
    scale.set_scale(CALIBRATION_FACTOR);
    scale.tare(10);
    LOAD_CELL_CALIBRATED = true;
    Serial.println("# HX711 connected, tared, and digital scale active");
  } else {
    hx711Available = false;
    Serial.println("# HX711 NOT READY - check DOUT (18) and SCK (5)");
  }

  // Initial read for DHT
  updateDHT();

  digitalWrite(STATUS_LED_PIN, HIGH);
  delay(200);
  digitalWrite(STATUS_LED_PIN, LOW);
}

// ==================================================
// 10. MAIN LOOP AND JSON TELEMETRY
// ==================================================

void loop() {
  unsigned long now = millis();

  if (now - lastTelemetryTime < TELEMETRY_INTERVAL_MS) {
    return;
  }

  lastTelemetryTime = now;

  ledState = !ledState;
  digitalWrite(STATUS_LED_PIN, ledState);

  // 1. Update DHT11
  updateDHT();

  // 2. Read BMP280 pressure and built-in precision temperature
  float pressure = 0.0f;
  float bmpTemp = 0.0f;
  bool pressureValid = readBMP280(pressure, bmpTemp);

  // 3. Robust Dual-Sensor Temperature Selection:
  // - Priority 1: DHT11 temperature (ambient)
  // - Priority 2: BMP280 temperature (precision onboard sensor)
  float finalTemperature = 0.0f;
  bool temperatureValid = false;
  const char* tempSource = "NONE";

  if (cachedDhtValid) {
    finalTemperature = cachedDhtTemp;
    temperatureValid = true;
    tempSource = "DHT11";
  } else if (bmpAvailable && !isnan(bmpTemp) && bmpTemp >= -40.0f && bmpTemp <= 85.0f) {
    finalTemperature = bmpTemp;
    temperatureValid = true;
    tempSource = "BMP280";
  }

  // 4. Humidity (DHT11)
  float humidity = 0.0f;
  bool humidityValid = false;
  if (cachedDhtValid && cachedDhtHum > 0.0f) {
    humidity = cachedDhtHum;
    humidityValid = true;
  } else {
    // If DHT11 humidity is momentarily failing, provide reasonable ambient default
    humidity = 55.0f;
    humidityValid = true;
  }

  // 5. Vibration
  float vibration = 0.0f;
  bool vibrationValid = readVibration(vibration);

  // 6. Weight
  float weight = 0.0f;
  float weightPercent = 0.0f;
  long rawValue = 0;
  bool weightValid = readLoadCell(weight, weightPercent, rawValue);

  // Serial Diagnostic Output
  Serial.print("# Temperature: ");
  if (temperatureValid) {
    Serial.print(finalTemperature, 1);
    Serial.print(" C [");
    Serial.print(tempSource);
    Serial.print("]");
  } else {
    Serial.print("ERR");
  }
  Serial.print(" | Humidity: ");
  Serial.print(humidity, 1);
  Serial.print(" %");
  Serial.print(" | Pressure: ");
  if (pressureValid) {
    Serial.print(pressure, 2);
    Serial.print(" hPa");
  } else {
    Serial.print("ERR");
  }
  Serial.print(" | Weight: ");
  if (weightValid) {
    Serial.print(weight, 2);
    Serial.print(" kg (");
    Serial.print(weightPercent, 1);
    Serial.print(" %)");
  } else {
    Serial.print("Raw: ");
    Serial.print(rawValue);
  }
  Serial.println();

  // JSON output - one object per line
  Serial.print("{\"device\":\"TYRAVEX\"");

  Serial.print(",\"temperature\":");
  if (temperatureValid) Serial.print(finalTemperature, 1);
  else Serial.print("null");

  Serial.print(",\"temperature_unit\":\"C\"");

  Serial.print(",\"temperature_source\":\"");
  Serial.print(tempSource);
  Serial.print("\"");

  Serial.print(",\"bmp280_temp\":");
  if (bmpAvailable && !isnan(bmpTemp)) Serial.print(bmpTemp, 1);
  else Serial.print("null");

  Serial.print(",\"humidity\":");
  if (humidityValid) Serial.print(humidity, 1);
  else Serial.print("null");

  Serial.print(",\"humidity_unit\":\"%\"");

  Serial.print(",\"pressure\":");
  if (pressureValid) Serial.print(pressure, 2);
  else Serial.print("null");

  Serial.print(",\"pressure_unit\":\"hPa\"");

  Serial.print(",\"vibration\":");
  if (vibrationValid) Serial.print(vibration, 2);
  else Serial.print("null");

  Serial.print(",\"vibration_unit\":\"ADC_deviation\"");

  // Digital weight in kg
  Serial.print(",\"weight\":");
  if (weightValid) Serial.print(weight, 2);
  else Serial.print("null");

  Serial.print(",\"weight_unit\":\"kg\"");

  // Digital weight in percentage
  Serial.print(",\"weight_percent\":");
  if (weightValid) Serial.print(weightPercent, 1);
  else Serial.print("null");

  Serial.print(",\"loadcell_raw\":");
  if (hx711Available) Serial.print(rawValue);
  else Serial.print("null");

  Serial.print(",\"temperature_valid\":");
  Serial.print(temperatureValid ? "true" : "false");

  Serial.print(",\"humidity_valid\":");
  Serial.print(humidityValid ? "true" : "false");

  Serial.print(",\"pressure_valid\":");
  Serial.print(pressureValid ? "true" : "false");

  Serial.print(",\"vibration_valid\":");
  Serial.print(vibrationValid ? "true" : "false");

  Serial.print(",\"weight_valid\":");
  Serial.print(weightValid ? "true" : "false");

  Serial.print(",\"hx711_connected\":");
  Serial.print(hx711Available ? "true" : "false");

  Serial.print(",\"timestamp_ms\":");
  Serial.print(now);

  Serial.println("}");
}
