{
  lib,
  stdenvNoCC,
  fetchPnpmDeps,
  pnpmConfigHook,
  pnpm_12,
  nodejs_26,
  nodejs-slim_26,
  makeBinaryWrapper,
}:
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "tagteam";
  inherit (lib.importJSON ../package.json) version;

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json
      ../pnpm-lock.yaml
      ../pnpm-workspace.yaml
      ../src
    ];
  };

  # Node runs the TypeScript sources directly, so only the runtime
  # dependencies are installed.
  pnpmInstallFlags = ["--prod"];
  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs) pname version src pnpmInstallFlags;
    pnpm = pnpm_12;
    fetcherVersion = 4;
    hash = "sha256-6xtzXk86lWap1yhunljOWFuc/MQhc7XcbtVq5VH1oPs=";
  };

  strictDeps = true;
  nativeBuildInputs = [pnpmConfigHook pnpm_12 nodejs_26 makeBinaryWrapper];
  dontBuild = true;

  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/tagteam
    cp -r package.json src node_modules $out/lib/tagteam
    makeWrapper ${lib.getExe nodejs-slim_26} $out/bin/tagteam \
      --add-flags $out/lib/tagteam/src/index.ts
    runHook postInstall
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    $out/bin/tagteam --version | grep -F ${finalAttrs.version}
    runHook postInstallCheck
  '';

  meta = {
    description = (lib.importJSON ../package.json).description;
    homepage = "https://github.com/k3dom/tagteam";
    mainProgram = "tagteam";
    platforms = lib.platforms.linux;
  };
})
