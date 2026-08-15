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
    let signer = parse_hex_32("QOS_FW_SIGNER_HEX");
    let genesis = parse_hex_32("QOS_FW_GENESIS_HEX");
    let destination = parse_hex_32("QOS_FW_DESTINATION_HEX");
    let token_mint = parse_hex_32("QOS_FW_TOKEN_MINT_HEX");
    let token_program = parse_hex_32("QOS_FW_TOKEN_PROGRAM_HEX");
    let source_token = parse_hex_32("QOS_FW_SOURCE_TOKEN_HEX");
    let destination_token = parse_hex_32("QOS_FW_DESTINATION_TOKEN_HEX");
    let max_amount = required("QOS_FW_MAX_AMOUNT").parse::<u64>().expect("invalid QOS_FW_MAX_AMOUNT");
    let max_fee = required("QOS_FW_MAX_FEE").parse::<u64>().expect("invalid QOS_FW_MAX_FEE");
    let max_ttl_slots = required("QOS_FW_MAX_TTL_SLOTS").parse::<u64>().expect("invalid QOS_FW_MAX_TTL_SLOTS");
    let strategy_id = required("QOS_FW_STRATEGY_ID").parse::<u32>().expect("invalid QOS_FW_STRATEGY_ID");
    let token_enabled = match required("QOS_FW_TOKEN_ENABLED").as_str() {
        "0" => false,
        "1" => true,
        _ => panic!("invalid QOS_FW_TOKEN_ENABLED"),
    };
    let token_decimals = required("QOS_FW_TOKEN_DECIMALS").parse::<u8>().expect("invalid QOS_FW_TOKEN_DECIMALS");
    let max_token_amount = required("QOS_FW_MAX_TOKEN_AMOUNT").parse::<u64>().expect("invalid QOS_FW_MAX_TOKEN_AMOUNT");
    let generated = format!(
        "pub const POLICY_SIGNER: [u8; 32] = {};\n\
         pub const POLICY_GENESIS: [u8; 32] = {};\n\
         pub const POLICY_DESTINATION: [u8; 32] = {};\n\
         pub const POLICY_TOKEN_MINT: [u8; 32] = {};\n\
         pub const POLICY_TOKEN_PROGRAM: [u8; 32] = {};\n\
         pub const POLICY_SOURCE_TOKEN: [u8; 32] = {};\n\
         pub const POLICY_DESTINATION_TOKEN: [u8; 32] = {};\n\
         pub const POLICY_MAX_AMOUNT: u64 = {max_amount};\n\
         pub const POLICY_MAX_FEE: u64 = {max_fee};\n\
         pub const POLICY_MAX_TTL_SLOTS: u64 = {max_ttl_slots};\n\
         pub const POLICY_STRATEGY_ID: u32 = {strategy_id};\n\
         pub const POLICY_TOKEN_ENABLED: bool = {token_enabled};\n\
         pub const POLICY_TOKEN_DECIMALS: u8 = {token_decimals};\n\
         pub const POLICY_MAX_TOKEN_AMOUNT: u64 = {max_token_amount};\n",
        bytes(&signer),
        bytes(&genesis),
        bytes(&destination),
        bytes(&token_mint),
        bytes(&token_program),
        bytes(&source_token),
        bytes(&destination_token),
    );
    let output = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR missing")).join("provisioned_policy.rs");
    fs::write(output, generated).expect("failed to create provisioned firmware policy");
}
