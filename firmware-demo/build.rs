use std::env;
use std::fs;
use std::path::PathBuf;

fn required(name: &str) -> String {
    println!("cargo:rerun-if-env-changed={name}");
    env::var(name).unwrap_or_else(|_| panic!("{name} must be set by the qOS provisioning tool"))
}

fn parse_hex_32(name: &str) -> [u8; 32] {
    let text = required(name);
    assert!(text.len() == 64, "{name} must contain exactly 64 hexadecimal characters");
    let mut output = [0u8; 32];
    for index in 0..32 {
        output[index] = u8::from_str_radix(&text[index * 2..index * 2 + 2], 16)
            .unwrap_or_else(|_| panic!("{name} contains invalid hexadecimal data"));
    }
    output
}

fn bytes(value: &[u8; 32]) -> String {
    let values = value.iter().map(|byte| format!("0x{byte:02x}")).collect::<Vec<_>>().join(", ");
    format!("[{values}]")
}

fn main() {
    let seed = parse_hex_32("QOS_FW_SEED_HEX");
    let genesis = parse_hex_32("QOS_FW_GENESIS_HEX");
    let destination = parse_hex_32("QOS_FW_DESTINATION_HEX");
    let max_amount = required("QOS_FW_MAX_AMOUNT").parse::<u64>().expect("invalid QOS_FW_MAX_AMOUNT");
    let max_fee = required("QOS_FW_MAX_FEE").parse::<u64>().expect("invalid QOS_FW_MAX_FEE");
    let strategy_id = required("QOS_FW_STRATEGY_ID").parse::<u32>().expect("invalid QOS_FW_STRATEGY_ID");
    let generated = format!(
        "pub const POLICY_SEED: [u8; 32] = {};\n\
         pub const POLICY_GENESIS: [u8; 32] = {};\n\
         pub const POLICY_DESTINATION: [u8; 32] = {};\n\
         pub const POLICY_MAX_AMOUNT: u64 = {max_amount};\n\
         pub const POLICY_MAX_FEE: u64 = {max_fee};\n\
         pub const POLICY_STRATEGY_ID: u32 = {strategy_id};\n",
        bytes(&seed),
        bytes(&genesis),
        bytes(&destination),
    );
    let output = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR missing")).join("provisioned_policy.rs");
    fs::write(output, generated).expect("failed to create provisioned firmware policy");
}

