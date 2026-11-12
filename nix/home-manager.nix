self: {
  config,
  lib,
  pkgs,
  ...
}: let
  cfg = config.services.tagteam;
  threshold = plan: default:
    lib.mkOption {
      type = lib.types.ints.between 1 100;
      inherit default;
      description = "Percentage of its 5-hour or weekly limit at which tagteam switches away from a ${plan} account.";
    };
in {
  imports = [
    (lib.mkRemovedOptionModule ["services" "tagteam" "threshold"] "Set services.tagteam.thresholds.pro, .max5x and .max20x instead.")
  ];

  options.services.tagteam = {
    enable = lib.mkEnableOption "tagteam, which rotates Claude Code between your accounts as they near their rate limits";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = lib.literalExpression "tagteam.packages.\${pkgs.stdenv.hostPlatform.system}.default";
      description = "The tagteam package to use.";
    };

    thresholds = {
      pro = threshold "Pro" 90;
      max5x = threshold "Max 5x" 95;
      max20x = threshold "Max 20x" 97;
    };

    interval = lib.mkOption {
      type = lib.types.addCheck lib.types.int (seconds: seconds >= 10) // {description = "integer of at least 10";};
      default = 60;
      description = "Seconds between usage checks. Anthropic rate limits usage requests, so it can't go below 10.";
    };

    herdr.enable = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        Whether to install the tagteam-usage mod for the Herdr desktop app, a
        window that shows the usage of your accounts. Open it once with Herdr's
        mod.open command, after which Herdr reopens it on every start.
      '';
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

    xdg.configFile."herdr-app/mods/tagteam-usage" = lib.mkIf cfg.herdr.enable {
      source = "${cfg.package}/share/tagteam/herdr/tagteam-usage";
      # Herdr writes its type files into the mod's folder, so only the files
      # are linked.
      recursive = true;
    };

    systemd.user.services.tagteam = {
      Unit = {
        Description = "Rotate Claude Code between accounts";
        Documentation = "https://github.com/k3dom/tagteam";
      };
      Service = {
        ExecStart = lib.escapeShellArgs [
          (lib.getExe cfg.package)
          "daemon"
          "--threshold-pro"
          cfg.thresholds.pro
          "--threshold-max-5x"
          cfg.thresholds.max5x
          "--threshold-max-20x"
          cfg.thresholds.max20x
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
