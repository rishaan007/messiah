# Windows AppContainer Helper

Provides the native Windows Win32 `CreateAppContainerProfile` + `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` boundary expected by `SandboxDetector` when `MESSIAH_WIN_APPCONTAINER_HELPER` is configured on Windows hosts.

## Build on Windows x64 (MSVC / Visual Studio Build Tools)

```powershell
cmake -S . -B build -G "Visual Studio 17 2022" -A x64
cmake --build build --config Release
setx MESSIAH_WIN_APPCONTAINER_HELPER "$PWD\build\Release\messiah-appcontainer-helper.exe"
messiah-appcontainer-helper.exe --probe
```

## Security Invariant

On Windows workstations where this helper binary has NOT been built and verified with `--probe`, `@messiah/bridge-daemon` **fails closed** (`SandboxUnavailableError`) and refuses to execute ordinary unsandboxed child processes or local stdio MCP servers.
