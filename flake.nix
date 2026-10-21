{
  description = "Development environment for tagteam";
  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
  };
  outputs = {nixpkgs, ...}: let
    eachSupportedSystem = f:
      nixpkgs.lib.genAttrs nixpkgs.lib.systems.flakeExposed (
        system: f {pkgs = import nixpkgs {inherit system;};}
      );
  in {
    devShells = eachSupportedSystem ({pkgs}: {
      default = pkgs.mkShell {
        packages = with pkgs; [
          nodejs_26
          pnpm_12
          jq
          ripgrep
        ];

        env = {
          pnpm_config_update_notifier = "false";
          pnpm_config_pm_on_fail = "ignore";
        };

        shellHook = ''
          if [ ! -d node_modules ] || {
            [ -f pnpm-lock.yaml ] && [ pnpm-lock.yaml -nt node_modules/.modules.yaml ]
          }; then
            echo "warn: Dependencies may be out of date. Run 'pnpm i' to update."
          fi
        '';
      };
    });
    formatter = eachSupportedSystem ({pkgs}: pkgs.alejandra);
  };
}
