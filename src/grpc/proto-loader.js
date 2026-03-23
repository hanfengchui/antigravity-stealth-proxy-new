/**
 * Proto loader — loads and compiles the Cloud Code proto definition
 * Uses protobufjs for message type access and @grpc/proto-loader for gRPC service definition
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as protoLoader from '@grpc/proto-loader';
import * as grpc from '@grpc/grpc-js';
import protobuf from 'protobufjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = join(__dirname, 'cloudcode.proto');

// Lazy-loaded singletons
let _grpcPackageDef = null;
let _protoRoot = null;
let _serviceClient = null;

/**
 * Load proto via @grpc/proto-loader (for gRPC service client)
 */
function loadGrpcPackage() {
  if (_grpcPackageDef) return _grpcPackageDef;

  const packageDef = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,         // Convert to camelCase for JS
    longs: Number,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs: [
      join(__dirname, '../../node_modules/protobufjs'),
      join(__dirname, '../../node_modules/@grpc/proto-loader/build/proto')
    ]
  });

  _grpcPackageDef = grpc.loadPackageDefinition(packageDef);
  return _grpcPackageDef;
}

/**
 * Load proto via protobufjs (for message type access and manual encode/decode)
 */
async function loadProtoRoot() {
  if (_protoRoot) return _protoRoot;

  const root = new protobuf.Root();
  // Resolve google/protobuf/struct.proto from protobufjs common protos
  root.resolvePath = (origin, target) => {
    if (target.startsWith('google/protobuf/')) {
      return join(__dirname, '../../node_modules/protobufjs', target);
    }
    if (origin) {
      return join(dirname(origin), target);
    }
    return target;
  };

  _protoRoot = await root.load(PROTO_PATH);
  return _protoRoot;
}

/**
 * Get the gRPC service client constructor for PredictionService
 */
export function getServiceClient() {
  if (_serviceClient) return _serviceClient;

  const pkg = loadGrpcPackage();
  _serviceClient = pkg.google.internal.cloud.code.v1internal.PredictionService;
  return _serviceClient;
}

/**
 * Get protobufjs message types for manual encode/decode
 */
export async function getMessageTypes() {
  const root = await loadProtoRoot();

  return {
    StreamGenerateContentRequest: root.lookupType(
      'google.internal.cloud.code.v1internal.StreamGenerateContentRequest'
    ),
    StreamGenerateContentResponse: root.lookupType(
      'google.internal.cloud.code.v1internal.StreamGenerateContentResponse'
    ),
    GenerateContentRequest: root.lookupType(
      'google.internal.cloud.code.v1internal.GenerateContentRequest'
    ),
    GenerateContentResponse: root.lookupType(
      'google.internal.cloud.code.v1internal.GenerateContentResponse'
    ),
    Content: root.lookupType('google.internal.cloud.code.v1internal.Content'),
    Part: root.lookupType('google.internal.cloud.code.v1internal.Part'),
    Struct: root.lookupType('google.protobuf.Struct'),
  };
}

export { PROTO_PATH };
