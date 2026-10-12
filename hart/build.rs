// The JIT (src/jit.rs) puts the functions it compiles into the module's
// function table, which JavaScript (src/cpu.ts) grows and fills: export it,
// and let it grow.
fn main() {
    if std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() == Ok("wasm32") {
        println!("cargo:rustc-cdylib-link-arg=--export-table");
        println!("cargo:rustc-cdylib-link-arg=--growable-table");
    }
}
