<h1 align="center">
  Frank
</h1>

<p align="center">
  A Monad powered cryptomessenger.
</p>

**WARNING: Frank is in early alpha development stage (forked from Stamp/Lotus, migrating to Monad). There will be multiple breaking changes from now until a stable release. We default to a Monad testnet as to protect against lost funds.**

## Install from Binary

1. Download the appropriate binary for your machine from the [latest releases](https://github.com/stampchat/stamp/releases).
2. Unzip your package.
3. Run it.

## Build from Source

### Requirements

- [Quasar](https://quasar.dev/start/pick-quasar-flavour)

### Cloning the Source

Clone this repository using

```bash
git clone https://github.com/schancel/frank.git
cd frank
```

The UI calls `@frank/wallet` and `@frank/cashweb`. It does not own chain
codecs, encryption suites, or CashWeb CBOR layouts. A few screens still import
`bitcore-lib-xpi` while issue #257 is open.

### Development Mode

Running the following command should run electron in development mode and watch the source files with hot reloading enabled:

```bash
yarn dev
```

### Linux, MacOS and Windows Builds

```bash
yarn install
yarn build
```

Your binary will be located in `/dist/electron/Packaged/` folder.

You may cross-platform compile to the following targets:

- `darwin`
- `mac`
- `win32`
- `win`
- `linux`

```bash
yarn install
quasar build -m electron -b builder -T {target here}
```

Note that one cannot cross-compile to MacOS and that building from Linux to Windows requires [Wine](https://www.winehq.org/).

More information can be found [here](https://www.electron.build/) and [here](https://quasar.dev/quasar-cli/developing-electron-apps/build-commands).

### Android

**Unstable**

```bash
quasar build -m capacitor -T android
```

### iOS

**Unstable**

```bash
quasar build -m capacitor -T ios
```

In order to remote debugging on real ios device, the devtools option in quasar.conf.js should not be 'source-map'. Instead try 'eval-source-map'
The root cause is that the Safari web inspector disconnects/crashes when the size of any files are too large.

### Updating the generated protobuf files:

If the protobuf files need to change due to the addition of a new entry type, or some addition, the following commands will allow for the regeneration of these files.
Please check them into the repo after they have been generated.

- [Protobuf compiler](https://github.com/protocolbuffers/protobuf)

```bash
git submodule update --init --recursive
yarn generate:protobuffers
```

## Usage

**TODO**

# Licensing

The Stamp GUI is licensed under GPLv3. However, the subfolder `src/cashweb/` is
licensed under MIT. This subfolder is a set of libraries for interacting with
CashWeb backends.
