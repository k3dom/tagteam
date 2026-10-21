self: {
  config,
  lib,
  pkgs,
  ...
}: let
  cfg = config.services.tagteam;
in {
  options.services.tagteam = {
    enable = lib.mkEnableOption "tagteam, which rotates Claude Code between your accounts as they near their rate limits";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = lib.literalExpression "tagteam.packages.\${pkgs.stdenv.hostPlatform.system}.default";
      description = "The tagteam package to use.";
    };

    threshold = lib.mkOption {
      type = lib.types.ints.between 1 100;
      default = 90;
      description = "Percentage of its 5-hour or weekly limit at which tagteam switches away from an account.";
    };

    interval = lib.mkOption {
      type = lib.types.addCheck lib.types.int (seconds: seconds >= 10) // {description = "integer of at least 10";};
      default = 60;
      description = "Seconds between usage checks. Anthropic rate limits usage requests, so it can't go below 10.";
    };

    claudeCodePackage = lib.mkOption {
      type = lib.types.nullOr lib.types.package;
      default =
        if config.programs.claude-code.enable
        then config.programs.claude-code.package
        else null;
      defaultText = lib.literalExpression "config.programs.claude-code.package, if enabled";
      description = ''
        Claude Code, whose version tagteam sends with its requests to Anthropic.
        Anthropic rate limits usage requests harder for other clients.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [cfg.package];

    systemd.user.services.tagteam = {
      Unit = {
        Description = "Rotate Claude Code between accounts";
        Documentation = "https://github.com/k3dom/tagteam";
      };
      Service = {
        ExecStart = lib.escapeShellArgs [
          (lib.getExe cfg.package)
          "daemon"
          "--threshold"
          cfg.threshold
          "--interval"
          cfg.interval
        ];
        Environment = lib.optional (cfg.claudeCodePackage != null) "PATH=${lib.makeBinPath [cfg.claudeCodePackage]}";
        Restart = "on-failure";
        RestartSec = 30;
      };
      Install.WantedBy = ["default.target"];
    };
  };
}
