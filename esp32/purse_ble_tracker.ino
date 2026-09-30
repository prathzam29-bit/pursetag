#include <Arduino.h>
#include <TinyGPSPlus.h>
#include <BLE2902.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>

constexpr int GPS_RX_PIN = 16;
constexpr int GPS_TX_PIN = 17;
constexpr uint32_t GPS_BAUD = 9600;
constexpr uint32_t GPS_FIX_MAX_AGE_MS = 5000;
constexpr uint32_t BLE_UPDATE_INTERVAL_MS = 1000;
constexpr int RFID_INPUT_PINS[] = {32, 26, 27};
constexpr uint32_t RFID_STATUS_INTERVAL_MS = 1000;

static const char *BLE_DEVICE_NAME = "PurseGuard";
static const char *BLE_SERVICE_UUID = "4fafc201-1fb5-459e-8fcc-c5c9c331914b";
static const char *BLE_LOCATION_CHARACTERISTIC_UUID = "beb5483e-36e1-4688-b7f5-ea07361b26a8";
static const char *BLE_RFID_CHARACTERISTIC_UUID = "cba1d466-344c-4be3-ab3f-189f80dd7518";
static const char *RFID_ITEM_NAMES[] = {"House Keys", "Office Tag", "Spare"};

TinyGPSPlus gps;
BLECharacteristic *locationCharacteristic = nullptr;
BLECharacteristic *rfidCharacteristic = nullptr;
BLEAdvertising *bleAdvertising = nullptr;
uint32_t lastBleUpdateMs = 0;
uint32_t lastRfidStatusMs = 0;

class PurseServerCallbacks : public BLEServerCallbacks {
	void onDisconnect(BLEServer *server) override {
		(void)server;
		bleAdvertising->start();
		Serial.println("BLE client disconnected; advertising again");
	}
};

void publishRfidStatus() {
	String payload = "RFID";
	for (size_t i = 0; i < 3; i++) {
		const bool present = digitalRead(RFID_INPUT_PINS[i]) == HIGH;
		payload += ",";
		payload += present ? "1" : "0";
	}

	rfidCharacteristic->setValue(
			reinterpret_cast<const uint8_t *>(payload.c_str()), payload.length());
	rfidCharacteristic->notify();
	Serial.print("[RFID GPIO] Snapshot: ");
	Serial.println(payload);
}

void publishGpsLocation() {
	const bool hasFreshFix = gps.location.isValid() && gps.location.age() <= GPS_FIX_MAX_AGE_MS;
	String payload;

	if (hasFreshFix) {
		payload.reserve(100);
		payload = "{\"fix\":true,\"lat\":";
		payload += String(gps.location.lat(), 6);
		payload += ",\"lon\":";
		payload += String(gps.location.lng(), 6);
		payload += ",\"sats\":";
		payload += String(gps.satellites.isValid() ? gps.satellites.value() : 0);
		payload += ",\"hdop\":";
		payload += String(gps.hdop.isValid() ? gps.hdop.hdop() : 99.9, 1);
		payload += "}";
	} else {
		payload = "{\"fix\":false}";
	}

	locationCharacteristic->setValue(
			reinterpret_cast<const uint8_t *>(payload.c_str()), payload.length());
	locationCharacteristic->notify();

	if (hasFreshFix) {
		Serial.println(payload);
	} else {
		Serial.println("Waiting for a fresh GPS fix");
	}
}
void setup() {
	Serial.begin(115200);
	Serial2.begin(GPS_BAUD, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);
	for (const int pin : RFID_INPUT_PINS) {
		pinMode(pin, INPUT_PULLDOWN);
	}

	BLEDevice::init(BLE_DEVICE_NAME);
	BLEDevice::setMTU(185);

	BLEServer *server = BLEDevice::createServer();
	server->setCallbacks(new PurseServerCallbacks());
	BLEService *service = server->createService(BLE_SERVICE_UUID);
	locationCharacteristic = service->createCharacteristic(
			BLE_LOCATION_CHARACTERISTIC_UUID,
			BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
	locationCharacteristic->addDescriptor(new BLE2902());
	locationCharacteristic->setValue("{\"fix\":false}");
	  rfidCharacteristic = service->createCharacteristic(
		  BLE_RFID_CHARACTERISTIC_UUID,
		  BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
	  rfidCharacteristic->addDescriptor(new BLE2902());
	  rfidCharacteristic->setValue("RFID,WAIT");
	service->start();

	bleAdvertising = BLEDevice::getAdvertising();
	bleAdvertising->addServiceUUID(BLE_SERVICE_UUID);
	bleAdvertising->setScanResponse(true);
	bleAdvertising->start();

	Serial.println("PurseGuard BLE is advertising");
	Serial.println("GPS input: NEO-6M TX to GPIO16, 9600 baud");
	Serial.println("RFID inputs: STM32 D2/D5/D4 to ESP32 GPIO32/26/27");
}

void loop() {
	while (Serial2.available() > 0) {
		gps.encode(Serial2.read());
	}

	const uint32_t now = millis();
	if (now - lastRfidStatusMs >= RFID_STATUS_INTERVAL_MS) {
		lastRfidStatusMs = now;
		publishRfidStatus();
	}
	if (now - lastBleUpdateMs >= BLE_UPDATE_INTERVAL_MS) {
		lastBleUpdateMs = now;
		publishGpsLocation();
	}
}
