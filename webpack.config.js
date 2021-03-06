const path = require("path");
const slsw = require("serverless-webpack");
const CopyPlugin = require("copy-webpack-plugin");

const entries = {};

Object.keys(slsw.lib.entries).forEach((key) => {
  // Exclude python files
  if (!slsw.lib.entries[key].match(/\.py$/)) {
    entries[key] = ["./source-map-install.js", slsw.lib.entries[key]];
  }
});

module.exports = {
  mode: slsw.lib.webpack.isLocal ? "development" : "production",
  entry: entries,
  devtool: "source-map",
  plugins: [
    new CopyPlugin({
      patterns: [
        {
          from: "./**/*.py",
          globOptions: { ignore: ["venv/**/*", "node_modules/**/*"] },
        },
      ],
    }),
  ],
  resolve: {
    extensions: [".js", ".jsx", ".json", ".ts", ".tsx"],
  },
  output: {
    libraryTarget: "commonjs",
    path: path.join(__dirname, ".webpack"),
    filename: "[name].js",
  },
  target: "node",
  module: {
    rules: [
      // all files with a `.ts` or `.tsx` extension will be handled by `ts-loader`
      { test: /\.tsx?$/, loader: "ts-loader" },
    ],
  },
};
