/*
 * SPDX-License-Identifier: BSD-2-Clause
 *
 * RV64 machine-mode reset entry for the Solana Secure Trading Appliance.
 * This is a single-hart stage-0 starter.  It verifies and transfers control
 * to an OpenSBI image through srtm_main(); networking and Solana code never
 * execute in this privilege domain.
 */

        .section .text.init, "ax", @progbits
        .option push
        .option norvc
        .p2align 2
        .globl  _start
        .type   _start, @function
_start:
        /* RISC-V firmware convention: a0=hartid, a1=FDT pointer. */
        bnez    a0, .Lpark_secondary

        .option push
        .option norelax
        la      gp, __global_pointer$
        .option pop

        la      sp, __stack_top
        andi    sp, sp, -16
        mv      s0, a1                    /* preserve FDT pointer */

        csrw    mie, zero                 /* no interrupts during verification */
        la      t0, .Lmachine_trap
        csrw    mtvec, t0

        /* Clear BSS using only fixed, linker-controlled bounds. */
        la      t0, __bss_start
        la      t1, __bss_end
.Lclear_bss:
        bgeu    t0, t1, .Lbss_done
        sd      zero, 0(t0)
        addi    t0, t0, 8
        j       .Lclear_bss
.Lbss_done:
        fence   rw, rw
        fence.i

        mv      a0, s0
        call    srtm_main                 /* a0 = verified OpenSBI entry or 0 */
        beqz    a0, .Lboot_failure

        mv      t0, a0
        li      a0, 0                     /* boot hart */
        mv      a1, s0                    /* device tree */
        fence   rw, rw
        fence.i
        jr      t0                        /* verified next stage remains M-mode */

.Lmachine_trap:
        csrr    a0, mcause
        csrr    a1, mtval
        call    platform_fail_closed
        j       .Lhalt

.Lboot_failure:
        li      a0, 0x42544641            /* "BTFA" */
        li      a1, 0
        call    platform_fail_closed

.Lhalt:
        csrw    mie, zero
        wfi
        j       .Lhalt

.Lpark_secondary:
        csrw    mie, zero
        wfi
        j       .Lpark_secondary
        .size   _start, .-_start
        .option pop

        .section .note.GNU-stack,"",@progbits

