#![no_std]
#![no_main]

use core::arch::global_asm;
use core::panic::PanicInfo;
use core::ptr::{read_volatile, write_volatile};
use ed25519_dalek::{Signer, SigningKey};

include!(concat!(env!("OUT_DIR"), "/provisioned_policy.rs"));

const UART_BASE: usize = 0x1000_0000;
const TEST_FINISHER: usize = 0x0010_0000;
const INTENT_BASE: usize = 0x8100_0000;
const KEY_BASE: usize = 0x8120_0000;
const HEADER_SIZE: usize = 16;
const FRAME_SIZE: usize = 304;
const MAX_FRAMES: usize = 4;
const MIN_BASE_FEE_LAMPORTS: u64 = 5_000;
const BUNDLE_MAGIC: [u8; 8] = *b"QOSINTV2";
const KEY_MAGIC: [u8; 8] = *b"QOSKEYV1";

global_asm!(
    r#"
    .section .text.init
    .global _start
_start:
    csrw mie, zero
    csrw mip, zero
    .option push
    .option norelax
    la gp, __global_pointer$
    .option pop
    la sp, __stack_top
    la t0, __bss_start
    la t1, __bss_end
1:
    bgeu t0, t1, 2f
    sd zero, 0(t0)
    addi t0, t0, 8
    j 1b
2:
    call rust_main
3:
    wfi
    j 3b
"#
);

#[panic_handler]
fn panic(_info: &PanicInfo) -> ! {
    uart_str("QOS_FW:FATAL panic\n");
    finish(false)
}

fn uart_byte(byte: u8) {
    unsafe {
        while read_volatile((UART_BASE + 5) as *const u8) & 0x20 == 0 {}
        write_volatile(UART_BASE as *mut u8, byte);
    }
}

fn uart_str(text: &str) {
    for byte in text.bytes() {
        if byte == b'\n' {
            uart_byte(b'\r');
        }
        uart_byte(byte);
    }
}

fn uart_hex(bytes: &[u8]) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for byte in bytes {
        uart_byte(HEX[(byte >> 4) as usize]);
        uart_byte(HEX[(byte & 0x0f) as usize]);
    }
}

fn uart_index(index: usize) {
    uart_byte(b'0' + index as u8);
}

fn finish(success: bool) -> ! {
    unsafe {
        write_volatile(TEST_FINISHER as *mut u32, if success { 0x5555 } else { 0x3333 });
    }
    loop {
        core::hint::spin_loop();
    }
}

fn read_input(offset: usize) -> u8 {
    unsafe { read_volatile((INTENT_BASE + offset) as *const u8) }
}

fn read_bundle_bytes(offset: usize, output: &mut [u8]) {
    for (index, byte) in output.iter_mut().enumerate() {
        *byte = read_input(offset + index);
    }
}

fn read_key_bytes(offset: usize, output: &mut [u8]) {
    for (index, byte) in output.iter_mut().enumerate() {
        *byte = unsafe { read_volatile((KEY_BASE + offset + index) as *const u8) };
    }
}

fn wipe_mailbox(base: usize, offset: usize, length: usize) {
    for index in 0..length {
        unsafe { write_volatile((base + offset + index) as *mut u8, 0) };
    }
}

fn le_u32(bytes: &[u8]) -> u32 {
    u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
}

fn le_u64(bytes: &[u8]) -> u64 {
    u64::from_le_bytes([
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
    ])
}

fn le_u128(bytes: &[u8]) -> u128 {
    u128::from_le_bytes([
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
        bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15],
    ])
}

fn reject(index: usize, code: &str) {
    uart_str("QOS_FW:REJECT index=");
    uart_index(index);
    uart_str(" code=");
    uart_str(code);
    uart_str("\n");
}

fn nonzero(bytes: &[u8]) -> bool {
    bytes.iter().fold(0u8, |value, byte| value | byte) != 0
}

fn push(output: &mut [u8], offset: &mut usize, bytes: &[u8]) {
    output[*offset..*offset + bytes.len()].copy_from_slice(bytes);
    *offset += bytes.len();
}

fn build_transfer_message(
    payer: &[u8; 32],
    destination: &[u8; 32],
    recent_blockhash: &[u8; 32],
    lamports: u64,
    output: &mut [u8],
) -> usize {
    let mut offset = 0;
    push(output, &mut offset, &[1, 0, 1]);
    push(output, &mut offset, &[3]);
    push(output, &mut offset, payer);
    push(output, &mut offset, destination);
    push(output, &mut offset, &[0u8; 32]);
    push(output, &mut offset, recent_blockhash);
    push(output, &mut offset, &[1]);
    push(output, &mut offset, &[2]);
    push(output, &mut offset, &[2, 0, 1]);
    push(output, &mut offset, &[12]);
    push(output, &mut offset, &[2, 0, 0, 0]);
    push(output, &mut offset, &lamports.to_le_bytes());
    offset
}

fn build_token_transfer_message(
    payer: &[u8; 32],
    source_token: &[u8; 32],
    destination_token: &[u8; 32],
    mint: &[u8; 32],
    token_program: &[u8; 32],
    recent_blockhash: &[u8; 32],
    amount: u64,
    decimals: u8,
    output: &mut [u8],
) -> usize {
    let mut offset = 0;
    push(output, &mut offset, &[1, 0, 2]);
    push(output, &mut offset, &[5]);
    push(output, &mut offset, payer);
    push(output, &mut offset, source_token);
    push(output, &mut offset, destination_token);
    push(output, &mut offset, mint);
    push(output, &mut offset, token_program);
    push(output, &mut offset, recent_blockhash);
    push(output, &mut offset, &[1]);
    push(output, &mut offset, &[4]);
    push(output, &mut offset, &[4, 1, 3, 2, 0]);
    push(output, &mut offset, &[10, 12]);
    push(output, &mut offset, &amount.to_le_bytes());
    push(output, &mut offset, &[decimals]);
    offset
}

fn wipe(bytes: &mut [u8]) {
    for byte in bytes {
        unsafe { write_volatile(byte as *mut u8, 0) };
    }
}

#[no_mangle]
extern "C" fn rust_main() -> ! {
    uart_str("QOS_FW:BOOT mode=M policy=typed-sol-or-token-transfer retention=ephemeral-memory\n");

    let mut magic = [0u8; 8];
    read_bundle_bytes(0, &mut magic);
    if magic != BUNDLE_MAGIC {
        wipe_mailbox(INTENT_BASE, 0, HEADER_SIZE);
        wipe(&mut magic);
        uart_str("QOS_FW:FATAL invalid-bundle-magic\n");
        finish(false);
    }
    let mut header_word = [0u8; 4];
    read_bundle_bytes(8, &mut header_word);
    let count = le_u32(&header_word) as usize;
    read_bundle_bytes(12, &mut header_word);
    wipe_mailbox(INTENT_BASE, 0, HEADER_SIZE);
    if count == 0 || count > MAX_FRAMES || le_u32(&header_word) as usize != FRAME_SIZE {
        wipe(&mut magic);
        wipe(&mut header_word);
        uart_str("QOS_FW:FATAL invalid-bundle-shape\n");
        finish(false);
    }
    wipe(&mut magic);
    wipe(&mut header_word);

    let mut key_magic = [0u8; 8];
    read_key_bytes(0, &mut key_magic);
    if key_magic != KEY_MAGIC {
        wipe_mailbox(KEY_BASE, 0, 40);
        wipe(&mut key_magic);
        uart_str("QOS_FW:FATAL invalid-key-mailbox\n");
        finish(false);
    }
    let mut seed = [0u8; 32];
    read_key_bytes(8, &mut seed);
    wipe_mailbox(KEY_BASE, 0, 40);
    wipe(&mut key_magic);
    let signing_key = SigningKey::from_bytes(&seed);
    wipe(&mut seed);

    let payer = signing_key.verifying_key().to_bytes();
    uart_str("QOS_FW:SIGNER_HEX ");
    uart_hex(&payer);
    uart_str("\n");

    let mut last_nonce = 0u128;
    let mut signed_count = 0usize;
    for index in 0..count {
        let mut frame = [0u8; FRAME_SIZE];
        read_bundle_bytes(HEADER_SIZE + index * FRAME_SIZE, &mut frame);
        wipe_mailbox(INTENT_BASE, HEADER_SIZE + index * FRAME_SIZE, FRAME_SIZE);

        let asset_kind = le_u32(&frame[4..8]);
        if le_u32(&frame[0..4]) != 2 || asset_kind > 1 || le_u32(&frame[164..168]) != 0 || nonzero(&frame[297..304]) {
            reject(index, "SHAPE");
            wipe(&mut frame);
            continue;
        }
        let nonce = le_u128(&frame[8..24]);
        if nonce == 0 || nonce <= last_nonce {
            reject(index, "NONCE_REPLAY");
            wipe(&mut frame);
            continue;
        }
        if frame[24..56] != POLICY_GENESIS {
            reject(index, "CLUSTER");
            wipe(&mut frame);
            continue;
        }
        if frame[56..88] != POLICY_DESTINATION || frame[56..88] == payer {
            reject(index, "DESTINATION");
            wipe(&mut frame);
            continue;
        }
        let amount = le_u64(&frame[88..96]);
        let minimum_output = le_u64(&frame[96..104]);
        let max_amount = if asset_kind == 0 { POLICY_MAX_AMOUNT } else { POLICY_MAX_TOKEN_AMOUNT };
        if amount == 0 || amount > max_amount || minimum_output != amount {
            reject(index, "AMOUNT");
            wipe(&mut frame);
            continue;
        }
        let max_fee = le_u64(&frame[104..112]);
        if max_fee < MIN_BASE_FEE_LAMPORTS || max_fee > POLICY_MAX_FEE {
            reject(index, "FEE");
            wipe(&mut frame);
            continue;
        }
        if !nonzero(&frame[112..144]) {
            reject(index, "BLOCKHASH");
            wipe(&mut frame);
            continue;
        }
        let expires_at_slot = le_u64(&frame[144..152]);
        let current_slot = le_u64(&frame[152..160]);
        if expires_at_slot <= current_slot || expires_at_slot > current_slot.saturating_add(POLICY_MAX_TTL_SLOTS) {
            reject(index, "EXPIRY");
            wipe(&mut frame);
            continue;
        }
        if le_u32(&frame[160..164]) != POLICY_STRATEGY_ID {
            reject(index, "STRATEGY");
            wipe(&mut frame);
            continue;
        }

        let mut destination = [0u8; 32];
        destination.copy_from_slice(&frame[56..88]);
        let mut blockhash = [0u8; 32];
        blockhash.copy_from_slice(&frame[112..144]);
        let mut message = [0u8; 256];
        let message_length = if asset_kind == 0 {
            if nonzero(&frame[168..304]) {
                reject(index, "TOKEN_FIELDS");
                wipe(&mut destination);
                wipe(&mut blockhash);
                wipe(&mut message);
                wipe(&mut frame);
                continue;
            }
            build_transfer_message(&payer, &destination, &blockhash, amount, &mut message)
        } else {
            if !POLICY_TOKEN_ENABLED
                || frame[168..200] != POLICY_TOKEN_MINT
                || frame[200..232] != POLICY_SOURCE_TOKEN
                || frame[232..264] != POLICY_DESTINATION_TOKEN
                || frame[264..296] != POLICY_TOKEN_PROGRAM
                || frame[296] != POLICY_TOKEN_DECIMALS
            {
                reject(index, "TOKEN_POLICY");
                wipe(&mut destination);
                wipe(&mut blockhash);
                wipe(&mut message);
                wipe(&mut frame);
                continue;
            }
            build_token_transfer_message(
                &payer,
                &POLICY_SOURCE_TOKEN,
                &POLICY_DESTINATION_TOKEN,
                &POLICY_TOKEN_MINT,
                &POLICY_TOKEN_PROGRAM,
                &blockhash,
                amount,
                POLICY_TOKEN_DECIMALS,
                &mut message,
            )
        };
        let mut signature = signing_key.sign(&message[..message_length]).to_bytes();
        let mut transaction = [0u8; 384];
        transaction[0] = 1;
        transaction[1..65].copy_from_slice(&signature);
        transaction[65..65 + message_length].copy_from_slice(&message[..message_length]);

        uart_str("QOS_FW:ACCEPT index=");
        uart_index(index);
        uart_str(" tx_hex=");
        uart_hex(&transaction[..65 + message_length]);
        uart_str("\n");
        last_nonce = nonce;
        signed_count += 1;
        wipe(&mut transaction);
        wipe(&mut signature);
        wipe(&mut message);
        wipe(&mut destination);
        wipe(&mut blockhash);
        wipe(&mut frame);
    }

    if signed_count == 0 {
        drop(signing_key);
        uart_str("QOS_FW:FATAL no-authorized-transaction\n");
        finish(false);
    }
    drop(signing_key);
    uart_str("QOS_FW:DONE\n");
    finish(true)
}
