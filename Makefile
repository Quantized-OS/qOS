CROSS_COMPILE ?= riscv64-linux-gnu-
CC := $(CROSS_COMPILE)gcc
CFLAGS := -march=rv64im_zicsr -mabi=lp64 -mcmodel=medany \
	-ffreestanding -fno-stack-protector -fno-pic -fno-builtin \
	-Os -g -Wall -Wextra -Werror -Ifirmware/include
LDFLAGS := -nostdlib -nostartfiles -static -T firmware/linker.ld

.PHONY: all check test sandbox-init firmware-demo-build firmware-demo firmware-demo-broadcast clean

all: build/stage0.elf

build:
	mkdir -p build

build/reset.o: firmware/reset.S | build
	$(CC) $(CFLAGS) -c $< -o $@

build/secure_boot.o: firmware/secure_boot.c firmware/include/platform.h | build
	$(CC) $(CFLAGS) -c $< -o $@

# A real platform must add implementations for every platform_* hook.
build/stage0.elf: build/reset.o build/secure_boot.o
	@echo "Platform security hooks are intentionally unresolved."
	@echo "Add your SoC-specific ROM key, ML-DSA, rollback, measurement, and PMP port."
	@false

check:
	python3 tests/static_checks.py
	node --check bin/qos.js
	node --check bin/qos-firmware-demo.js
	node --test

test:
	node --test

sandbox-init:
	node bin/qos.js init

firmware-demo-build:
	node bin/qos-firmware-demo.js build

firmware-demo:
	node bin/qos-firmware-demo.js run

firmware-demo-broadcast:
	node bin/qos-firmware-demo.js run --broadcast

clean:
	rm -f build/reset.o build/secure_boot.o build/stage0.elf
