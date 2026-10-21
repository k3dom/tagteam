{
  description = "Rotates Claude Code between your accounts as they near their rate limits";
  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
  };
  outputs = {
    self,
    nixpkgs,
    ...
  }: let
    eachSupportedSystem = f:
      nixpkgs.lib.genAttrs ["x86_64-linux" "aarch64-linux"] (
        system: f nixpkgs.legacyPackages.${system}
      );
    eachDevSystem = f:
      nixpkgs.lib.genAttrs nixpkgs.lib.systems.flakeExposed (
        system: f nixpkgs.legacyPackages.${system}
      );
  in {
    packages = eachSupportedSystem (pkgs: {
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.tagteam;
      tagteam = pkgs.callPackage ./nix/package.nix {};
    });

    overlays.default = _: prev: {
      tagteam = prev.callPackage ./nix/package.nix {};
    };

    homeManagerModules.default = import ./nix/home-manager.nix self;

    checks = eachSupportedSystem (pkgs: {
      tagteam = self.packages.${pkgs.stdenv.hostPlatform.system}.tagteam;
    });

    devShells = eachDevSystem (pkgs: {
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
    formatter = eachDevSystem (pkgs: pkgs.alejandra);
  };
}
