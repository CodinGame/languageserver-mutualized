import { Configuration } from 'webpack'
import HtmlWebpackPlugin from 'html-webpack-plugin'
import 'webpack-dev-server'
import path from 'path'

const config: Configuration = {
  entry: {
    main: path.resolve(__dirname, 'src/main.ts'),
    'editor.worker': 'monaco-editor/esm/vs/editor/editor.worker.js'
  },
  devtool: 'source-map',
  mode: 'development',
  module: {
    rules: [{
      test: /\.css$/,
      use: ['style-loader', 'css-loader']
    }, {
      test: /\.ttf$/,
      type: 'asset/resource',
      dependency: { not: ['url'] }
    }, {
      test: /\.(js|ts)$/,
      enforce: 'pre',
      loader: 'source-map-loader',
      exclude: [/vscode-jsonrpc/, /vscode-languageclient/, /vscode-languageserver-protocol/]
    }, {
      test: /\.ts$/,
      use: 'ts-loader',
      exclude: /node_modules/
    }]
  },
  plugins: [new HtmlWebpackPlugin({
    template: 'src/index.html',
    inject: 'body'
  })],
  target: 'web',
  resolve: {
    alias: {
      vscode: require.resolve('@codingame/monaco-languageclient/lib/vscode-compatibility'),
      'monaco-editor$': require.resolve('monaco-editor/esm/vs/editor/edcore.main') // useful to disable languages/workers
    },
    extensions: ['.js', '.json', '.ttf', '.ts']
  },
  devServer: {
    static: {
      directory: path.join(__dirname, 'src')
    },
    compress: true,
    port: 9000,
    open: true
  }
}

export default config
