#include <stdio.h>
#include <stdint.h>
#include <stdbool.h>
#include <string.h>

// MFRC522 registers
#define CommandReg      0x01
#define ComIEnReg       0x02
#define DivIEnReg       0x03
#define ComIrqReg       0x04
#define DivIrqReg       0x05
#define ErrorReg        0x06
#define Status1Reg      0x07
#define Status2Reg      0x08
#define FIFODataReg     0x09
#define FIFOLevelReg    0x0A
#define WaterLevelReg   0x0B
#define ControlReg      0x0C
#define BitFramingReg   0x0D
#define CollReg         0x0E
#define ModeReg         0x11
#define TxModeReg       0x12
#define RxModeReg       0x13
#define TxControlReg    0x14
#define TxASKReg        0x15
#define ModeWidthReg    0x24
#define RFCfgReg        0x26
#define RxThresholdReg  0x27
#define TModeReg        0x2A
#define TPrescalerReg   0x2B
#define TReloadRegH     0x2C
#define TReloadRegL     0x2D
#define VersionReg      0x37

// MFRC522 commands
#define PCD_IDLE        0x00
#define PCD_AUTHENT     0x0E
#define PCD_RECEIVE     0x08
#define PCD_TRANSMIT    0x04
#define PCD_TRANSCEIVE  0x0C
#define PCD_RESETRST    0x0F
#define PCD_CALCCRC     0x03

// RFID tag commands
#define PICC_REQIDL     0x26
#define PICC_REQALL     0x52
#define PICC_ANTICOLL   0x93

// Driver status codes
#define MI_OK           0
#define MI_NOTAGERR     1
#define MI_ERR          2

// Hardware register map
uint32_t volatile *const pPortABsrrReg = (uint32_t*) 0x40020018;
uint32_t volatile *const pPortBBsrrReg = (uint32_t*) 0x40020418;
uint32_t volatile *const pSpi1Cr1Reg   = (uint32_t*) 0x40013000;
uint32_t volatile *const pSpi1SrReg    = (uint32_t*) 0x40013008;
uint32_t volatile *const pSpi1DrReg    = (uint32_t*) 0x4001300C;

#define RFID_ITEM_COUNT       3U
#define RFID_SEEN_WINDOW_MS   5000U
#define RFID_STATUS_PERIOD_MS 1000U

// STM32 D2/D5/D4 output House Keys/Office Tag/Spare presence to ESP32.
#define RFID_GPIO_TEST_MODE   0U
// Set to 1 temporarily to read one tag UID at a time in the SWV console.
#ifndef RFID_UID_LEARN_MODE
#define RFID_UID_LEARN_MODE   0U
#endif

void delay_ms(uint32_t ms) {
    for (volatile uint32_t i = 0; i < ms * 3000; i++) {
        __asm__("nop");
    }
}

void SPI_GPIO_Init(void) {
    uint32_t volatile *const pClkAHB1enReg   = (uint32_t*) 0x40023830;
    uint32_t volatile *const pClkAPB2enReg   = (uint32_t*) 0x40023844;
    uint32_t volatile *const pPortAModeReg   = (uint32_t*) 0x40020000;
    uint32_t volatile *const pPortASpeedReg  = (uint32_t*) 0x40020008;
    uint32_t volatile *const pPortAAfrLowReg = (uint32_t*) 0x40020020;
    uint32_t volatile *const pPortBModeReg   = (uint32_t*) 0x40020400;

    *pClkAHB1enReg |= (1 << 0) | (1 << 1);
    *pClkAPB2enReg |= (1 << 12);

    *pPortAModeReg &= ~((3 << 10) | (3 << 12) | (3 << 14));
    *pPortAModeReg |=  ((2 << 10) | (2 << 12) | (2 << 14));

    *pPortASpeedReg &= ~((3 << 10) | (3 << 12) | (3 << 14));
    *pPortASpeedReg |=  ((2 << 10) | (2 << 12) | (2 << 14));

    *pPortAAfrLowReg &= ~((0xF << 20) | (0xF << 24) | (0xF << 28));
    *pPortAAfrLowReg |=  ((0x5 << 20) | (0x5 << 24) | (0x5 << 28));

    *pPortBModeReg &= ~(3 << 12);
    *pPortBModeReg |=  (1 << 12);

    *pPortAModeReg &= ~(3 << 18);
    *pPortAModeReg |=  (1 << 18);

    *pPortBBsrrReg = (1 << 6);
    *pPortABsrrReg = (1 << 9);

    delay_ms(10);
}

void SPI1_Init(void) {
    *pSpi1Cr1Reg = 0;
    *pSpi1Cr1Reg = (3 << 3) | (1 << 2) | (1 << 9) | (1 << 8) | (1 << 6);
}

void RfidStatusPins_Init(void) {
    uint32_t volatile *const pClkAHB1enReg = (uint32_t*) 0x40023830;
    uint32_t volatile *const pPortAModeReg = (uint32_t*) 0x40020000;
    uint32_t volatile *const pPortBModeReg = (uint32_t*) 0x40020400;

    *pClkAHB1enReg |= (1U << 0) | (1U << 1);
    *pPortAModeReg = (*pPortAModeReg & ~(3U << 20)) | (1U << 20);
    *pPortBModeReg = (*pPortBModeReg & ~((3U << 8) | (3U << 10))) |
                     (1U << 8) | (1U << 10);
    *pPortABsrrReg = (1U << (10U + 16U));
    *pPortBBsrrReg = (1U << (4U + 16U)) | (1U << (5U + 16U));
}

void SetRfidStatusPins(bool houseKeys, bool officeTag, bool spare) {
    *pPortABsrrReg = houseKeys ? (1U << 10) : (1U << (10U + 16U));

    const uint32_t setMask = (officeTag ? (1U << 4) : 0U) |
                             (spare ? (1U << 5) : 0U);
    const uint32_t resetMask = (officeTag ? 0U : (1U << 4)) |
                               (spare ? 0U : (1U << 5));
    *pPortBBsrrReg = setMask | (resetMask << 16);
}

uint8_t SPI_TransmitReceive(uint8_t data) {
    while (!(*pSpi1SrReg & (1 << 1)));
    *pSpi1DrReg = data;

    while (!(*pSpi1SrReg & (1 << 0)));
    return (uint8_t)(*pSpi1DrReg);
}

uint8_t RC522_ReadRegister(uint8_t regAddr) {
    uint8_t result;
    uint8_t addressByte = ((regAddr << 1) & 0x7E) | 0x80;

    *pPortBBsrrReg = (1 << (6 + 16));
    SPI_TransmitReceive(addressByte);
    result = SPI_TransmitReceive(0x00);
    *pPortBBsrrReg = (1 << 6);

    return result;
}

void RC522_WriteRegister(uint8_t regAddr, uint8_t value) {
    uint8_t addressByte = (regAddr << 1) & 0x7E;

    *pPortBBsrrReg = (1 << (6 + 16));
    SPI_TransmitReceive(addressByte);
    SPI_TransmitReceive(value);
    *pPortBBsrrReg = (1 << 6);
}

void RC522_SetBitMask(uint8_t reg, uint8_t mask) {
    uint8_t tmp = RC522_ReadRegister(reg);
    RC522_WriteRegister(reg, tmp | mask);
}

void RC522_ClearBitMask(uint8_t reg, uint8_t mask) {
    uint8_t tmp = RC522_ReadRegister(reg);
    RC522_WriteRegister(reg, tmp & (~mask));
}

void RC522_AntennaOn(void) {
    uint8_t temp = RC522_ReadRegister(TxControlReg);
    if (!(temp & 0x03)) {
        RC522_SetBitMask(TxControlReg, 0x03);
    }
}

void RC522_Init(void) {
    *pPortABsrrReg = (1 << (9 + 16));
    delay_ms(10);
    *pPortABsrrReg = (1 << 9);
    delay_ms(50);

    RC522_WriteRegister(CommandReg, PCD_RESETRST);
    delay_ms(50);

    RC522_WriteRegister(TModeReg, 0x8D);
    RC522_WriteRegister(TPrescalerReg, 0x3E);
    RC522_WriteRegister(TReloadRegL, 30);
    RC522_WriteRegister(TReloadRegH, 0);

    RC522_WriteRegister(TxASKReg, 0x40);
    RC522_WriteRegister(ModeReg, 0x3D);
    RC522_WriteRegister(RFCfgReg, (0x07 << 4));

    RC522_AntennaOn();
}

uint8_t RC522_ToCard(uint8_t command, uint8_t *sendData, uint8_t sendLen,
                     uint8_t *backData, uint32_t *backLen) {
    uint8_t status = MI_ERR;
    uint8_t irqEn = 0x00;
    uint8_t waitIRq = 0x00;
    uint8_t lastBits;
    uint8_t n;
    uint32_t i;

    if (command == PCD_TRANSCEIVE) {
        irqEn = 0x77;
        waitIRq = 0x30;
    }

    RC522_WriteRegister(ComIEnReg, irqEn | 0x80);
    RC522_ClearBitMask(ComIrqReg, 0x80);
    RC522_SetBitMask(FIFOLevelReg, 0x80);
    RC522_WriteRegister(CommandReg, PCD_IDLE);

    for (i = 0; i < sendLen; i++) {
        RC522_WriteRegister(FIFODataReg, sendData[i]);
    }

    RC522_WriteRegister(CommandReg, command);
    if (command == PCD_TRANSCEIVE) {
        RC522_SetBitMask(BitFramingReg, 0x80);
    }

    i = 2000;
    do {
        n = RC522_ReadRegister(ComIrqReg);
        i--;
    } while ((i != 0) && !(n & 0x01) && !(n & waitIRq));

    RC522_ClearBitMask(BitFramingReg, 0x80);

    if (i != 0) {
        if (!(RC522_ReadRegister(ErrorReg) & 0x1B)) {
            status = MI_OK;

            if (n & irqEn & 0x01) {
                status = MI_NOTAGERR;
            }

            if (command == PCD_TRANSCEIVE) {
                n = RC522_ReadRegister(FIFOLevelReg);
                lastBits = RC522_ReadRegister(ControlReg) & 0x07;

                if (lastBits) {
                    *backLen = (n - 1) * 8 + lastBits;
                } else {
                    *backLen = n * 8;
                }

                if (n == 0) n = 1;
                if (n > 16) n = 16;

                for (i = 0; i < n; i++) {
                    backData[i] = RC522_ReadRegister(FIFODataReg);
                }
            }
        } else {
            status = MI_ERR;
        }
    }

    return status;
}

uint8_t RC522_Request(uint8_t reqMode, uint8_t *TagType) {
    uint8_t status;
    uint32_t backBits = 0;

    RC522_WriteRegister(BitFramingReg, 0x07);

    TagType[0] = reqMode;
    status = RC522_ToCard(PCD_TRANSCEIVE, TagType, 1, TagType, &backBits);

    if ((status != MI_OK) || (backBits != 0x10 && backBits != 0x08)) {
        if (status == MI_OK && backBits > 0) {
            status = MI_OK;
        } else {
            status = MI_ERR;
        }
    }

    return status;
}

uint8_t RC522_Anticoll(uint8_t *serNum) {
    uint8_t status;
    uint8_t i;
    uint8_t serNumCheck = 0;
    uint32_t unLen = 0;

    RC522_WriteRegister(BitFramingReg, 0x00);

    serNum[0] = PICC_ANTICOLL;
    serNum[1] = 0x20;
    status = RC522_ToCard(PCD_TRANSCEIVE, serNum, 2, serNum, &unLen);

    if (status == MI_OK) {
        for (i = 0; i < 4; i++) {
            serNumCheck ^= serNum[i];
        }
        if (serNumCheck != serNum[4]) {
            status = MI_ERR;
        }
    }

    return status;
}

uint16_t RC522_CalculateCrcA(const uint8_t *data, uint8_t length) {
    uint16_t crc = 0x6363;

    for (uint8_t i = 0; i < length; i++) {
        uint8_t value = data[i] ^ (uint8_t)(crc & 0x00FFU);
        value ^= (uint8_t)(value << 4);
        crc = (crc >> 8) ^ ((uint16_t)value << 8) ^
              ((uint16_t)value << 3) ^ (value >> 4);
    }

    return crc;
}

bool RC522_SelectKnownUid(const uint8_t *uid) {
    uint8_t selectFrame[9] = {0x93, 0x70, uid[0], uid[1], uid[2], uid[3], 0, 0, 0};
    selectFrame[6] = uid[0] ^ uid[1] ^ uid[2] ^ uid[3];
    const uint16_t crc = RC522_CalculateCrcA(selectFrame, 7);
    selectFrame[7] = (uint8_t)(crc & 0xFFU);
    selectFrame[8] = (uint8_t)(crc >> 8);

    uint8_t response[16] = {0};
    uint32_t responseBits = 0;
    RC522_WriteRegister(BitFramingReg, 0x00);
    if (RC522_ToCard(PCD_TRANSCEIVE, selectFrame, sizeof(selectFrame),
                     response, &responseBits) != MI_OK || responseBits != 24U) {
        return false;
    }

    const uint16_t responseCrc =
        (uint16_t)response[1] | ((uint16_t)response[2] << 8);
    return responseCrc == RC522_CalculateCrcA(response, 1);
}

void RC522_HaltSelectedCard(void) {
    uint8_t haltFrame[4] = {0x50, 0x00, 0, 0};
    const uint16_t crc = RC522_CalculateCrcA(haltFrame, 2);
    haltFrame[2] = (uint8_t)(crc & 0xFFU);
    haltFrame[3] = (uint8_t)(crc >> 8);

    uint8_t response[16] = {0};
    uint32_t responseBits = 0;
    RC522_WriteRegister(BitFramingReg, 0x00);
    (void)RC522_ToCard(PCD_TRANSCEIVE, haltFrame, sizeof(haltFrame),
                       response, &responseBits);
}

typedef struct {
    const char* name;
    uint8_t uid[4];
} KeyChainItem;

// Replace these UIDs with the values read from your tags.
KeyChainItem myKeyChains[3] = {
    {"House Keys", {0x43, 0x63, 0x4A, 0xA3}},
    {"Office Tag", {0x19, 0x5C, 0x9E, 0x29}},
    {"Spare", {0x63, 0xAF, 0x0E, 0xA3}}
};

static bool itemSeen[RFID_ITEM_COUNT] = {false, false, false};
static uint32_t itemLastSeenMs[RFID_ITEM_COUNT] = {0, 0, 0};

void RecordScannedItem(uint8_t *scannedUID, uint32_t nowMs) {
    for (size_t i = 0; i < RFID_ITEM_COUNT; i++) {
        if (memcmp(scannedUID, myKeyChains[i].uid, sizeof(myKeyChains[i].uid)) == 0) {
            itemSeen[i] = true;
            itemLastSeenMs[i] = nowMs;
            printf("[SMART PURSE] Item Present: %s\n", myKeyChains[i].name);
            return;
        }
    }
    printf("[SMART PURSE] Unknown Tag Scanned!\n");
}

void SendRfidSnapshot(uint32_t nowMs) {
    bool present[RFID_ITEM_COUNT];

    for (size_t i = 0; i < RFID_ITEM_COUNT; i++) {
        present[i] = itemSeen[i] &&
            (uint32_t)(nowMs - itemLastSeenMs[i]) <= RFID_SEEN_WINDOW_MS;
    }

    SetRfidStatusPins(present[0], present[1], present[2]);
    printf("[RFID GPIO] Snapshot: %u,%u,%u\n",
           (unsigned int)present[0],
           (unsigned int)present[1],
           (unsigned int)present[2]);
}

int main(void) {
    RfidStatusPins_Init();
#if !RFID_GPIO_TEST_MODE
    SPI_GPIO_Init();
    SPI1_Init();
#endif

    printf("\n=========================================\n");
    printf("   STM32 Smart Purse - Key Chain Reader\n");
    printf("=========================================\n");

#if !RFID_GPIO_TEST_MODE
    RC522_Init();
    printf("Ready to scan key chains...\n\n");

    uint8_t str[16];
#if RFID_UID_LEARN_MODE
    uint8_t cardUID[5];
#endif
    uint32_t nowMs = 0;
    uint32_t lastRfidStatusMs = 0;
#else
    printf("GPIO test mode: D2/D5/D4 RFID status outputs HIGH.\n");
#endif

    while (1) {
#if RFID_GPIO_TEST_MODE
    SetRfidStatusPins(true, true, true);
    printf("[GPIO TEST] D2/D5/D4 HIGH\n");
        delay_ms(1000);
#else
#if RFID_UID_LEARN_MODE
        if (RC522_Request(PICC_REQALL, str) == MI_OK &&
            RC522_Anticoll(cardUID) == MI_OK) {
            printf("[UID LEARN] UID: %02X:%02X:%02X:%02X\n",
                   cardUID[0], cardUID[1], cardUID[2], cardUID[3]);
            delay_ms(500);
        }
#else
        for (size_t i = 0; i < RFID_ITEM_COUNT; i++) {
            if (RC522_Request(PICC_REQALL, str) == MI_OK &&
                RC522_SelectKnownUid(myKeyChains[i].uid)) {
                RecordScannedItem(myKeyChains[i].uid, nowMs);
                RC522_HaltSelectedCard();
            }
        }
#endif

        if ((uint32_t)(nowMs - lastRfidStatusMs) >= RFID_STATUS_PERIOD_MS) {
            SendRfidSnapshot(nowMs);
            lastRfidStatusMs = nowMs;
        }

        delay_ms(100);
        nowMs += 100U;
#endif
    }
}
