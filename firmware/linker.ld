OUTPUT_ARCH(riscv)
ENTRY(_start)

MEMORY {
    RAM (rwx) : ORIGIN = 0x80000000, LENGTH = 2M
}

SECTIONS {
    . = ORIGIN(RAM);

    .text : ALIGN(16) {
        KEEP(*(.text.init))
        *(.text .text.*)
    } > RAM

    .rodata : ALIGN(16) {
        *(.rodata .rodata.*)
    } > RAM

    .data : ALIGN(16) {
        PROVIDE(__global_pointer$ = . + 0x800);
        *(.sdata .sdata.*)
        *(.data .data.*)
    } > RAM

    .bss (NOLOAD) : ALIGN(16) {
        __bss_start = .;
        *(.sbss .sbss.*)
        *(.bss .bss.*)
        *(COMMON)
        . = ALIGN(16);
        __bss_end = .;
    } > RAM

    . = ALIGN(16);
    . += 16K;
    __stack_top = .;

    /DISCARD/ : { *(.comment) *(.eh_frame*) }
}

ASSERT(__stack_top <= ORIGIN(RAM) + LENGTH(RAM), "stage-0 image exceeds RAM")

