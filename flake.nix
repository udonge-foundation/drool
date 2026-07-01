{
  description = "Drool - AI coding agent CLI";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    # Bun dependency vendoring from bun.lock.
    bun2nix.url = "github:nix-community/bun2nix";
    bun2nix.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs =
    {
      self,
      nixpkgs,
      bun2nix,
      ...
    }:
    let
      lib = nixpkgs.lib;

      # These are the Unix-like release targets currently supported by Drool's
      # build/install scripts.
      supportedSystems = [
        "x86_64-linux"
        "aarch64-darwin"
      ];

      forAllSystems = f: lib.genAttrs supportedSystems (system: f system);
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = import nixpkgs {
            inherit system;
            overlays = [ bun2nix.overlays.default ];
          };

          packageJson = builtins.fromJSON (builtins.readFile ./package.json);

          targetForSystem = {
            x86_64-linux = "linux-x64";
            aarch64-darwin = "darwin-arm64";
          };

          artifactForSystem = {
            x86_64-linux = "drool-linux-x64";
            aarch64-darwin = "drool-darwin-arm64";
          };

          bunTarget = targetForSystem.${system};
          artifactName = artifactForSystem.${system};

          # Keep this flake self-contained by generating the bun2nix expression
          # from the checked-in bun.lock. For stricter CI/Hydra use, generate and
          # commit bun.nix, then replace this binding with: generatedBunNix = ./bun.nix;
          generatedBunNix = pkgs.runCommand "drool-bun.nix" { } ''
            ${lib.getExe pkgs.bun2nix} -l ${./bun.lock} -o "$out"
          '';

          drool = pkgs.stdenv.mkDerivation {
            pname = "drool";
            version = packageJson.version;

            src = lib.fileset.toSource {
              root = ./.;
              fileset = lib.fileset.unions [
                ./assets
                ./builtin-skills
                ./packages
                ./scripts
                ./src
                ./bun.lock
                ./package.json
                ./tsconfig.json
              ];
            };

            nativeBuildInputs = [
              pkgs.bun
              pkgs.bun2nix.hook
            ];

            bunDeps = pkgs.bun2nix.fetchBunDeps {
              bunNix = generatedBunNix;
            };

            # Drool uses a custom release script, not bun2nix's default build.
            dontUseBunBuild = true;
            dontUseBunInstall = true;
            dontRunLifecycleScripts = true;

            # Bun-compiled executables should not be stripped; stripping can break
            # the embedded payload.
            dontStrip = true;

            buildPhase = ''
              runHook preBuild

              export HOME="$TMPDIR"
              export BUN_EXECUTABLE="${lib.getExe pkgs.bun}"

              # Force Bun compile to use Nixpkgs' Bun executable as the native
              # compile base, avoiding network fetches for a compile runtime.
              export BUN_COMPILE_EXECUTABLE_PATH="${lib.getExe pkgs.bun}"

              bun ./scripts/build.mjs --release --outdir="$PWD/dist/bin" ${bunTarget}

              runHook postBuild
            '';

            installPhase = ''
              runHook preInstall

              install -Dm755 "dist/bin/${artifactName}" "$out/bin/drool"

              runHook postInstall
            '';

            meta = {
              description = "Industry's leading AI coding agent Drool";
              homepage = "https://github.com/udonge-foundation/drool";
              mainProgram = "drool";
              platforms = supportedSystems;
            };
          };
        in
        {
          default = drool;
          drool = drool;
        }
      );

      apps = forAllSystems (
        system:
        let
          pkgs = import nixpkgs {
            inherit system;
            overlays = [ bun2nix.overlays.default ];
          };
        in
        {
          default = {
            type = "app";
            program = "${self.packages.${system}.drool}/bin/drool";
          };

          drool = {
            type = "app";
            program = "${self.packages.${system}.drool}/bin/drool";
          };
        }
      );

      devShells = forAllSystems (
        system:
        let
          pkgs = import nixpkgs {
            inherit system;
            overlays = [ bun2nix.overlays.default ];
          };
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.bun
              pkgs.bun2nix
              pkgs.git
            ];

            shellHook = ''
              export BUN_EXECUTABLE="${lib.getExe pkgs.bun}"
              export BUN_COMPILE_EXECUTABLE_PATH="${lib.getExe pkgs.bun}"
            '';
          };
        }
      );

      formatter = forAllSystems (
        system:
        let
          pkgs = import nixpkgs {
            inherit system;
          };
        in
        pkgs.nixfmt-rfc-style
      );
    };
}