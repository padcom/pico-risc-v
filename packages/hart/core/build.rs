// The JIT (src/jit.rs) puts the functions it compiles into the module's
// function table, which JavaScript (src/cpu.ts) grows and fills: export it,
// and let it grow.
//
// The memory is shared, so harts can run on threads of their own, each in
// its own instance of the module (on the same memory): it's imported (src/
// cpu.ts makes it, INITIAL_MEMORY to start with, which must match), and the
// stack pointer exported, for each instance to get a stack of its own.
// (Atomic instructions: .cargo/config.toml.)
const INITIAL_MEMORY: u64 = 16 << 20;
const MAX_MEMORY: u64 = 4 << 30;

fn main() {
    if std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() == Ok("wasm32") {
        for arg in [
            "--export-table".to_string(),
            "--growable-table".to_string(),
            "--import-memory".to_string(),
            "--shared-memory".to_string(),
            format!("--initial-memory={INITIAL_MEMORY}"),
            format!("--max-memory={MAX_MEMORY}"),
            "--export=__stack_pointer".to_string(),
        ] {
            println!("cargo:rustc-cdylib-link-arg={arg}");
        }
    }
}
