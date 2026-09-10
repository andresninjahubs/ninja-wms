import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  CycleCountStrategy,
  OrderType,
  PickingStrategy,
  KitMode,
  RotationClass,
  Uom,
  UserRole,
  ZoneType,
} from '../domain/types';

/** Reserva de stock masiva: lista opcional de órdenes; si se omite, todas las RECEIVED. */
export class AllocateAllDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  orderIds?: string[];
}

export class CreateUserDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsString()
  @MaxLength(180)
  email!: string;

  @IsEnum(UserRole)
  role!: UserRole;

  // Solo la usa el PLATFORM_ADMIN; el ADMIN de operación crea en la suya.
  @IsOptional()
  @IsString()
  @MaxLength(64)
  operationId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  sellerId?: string;

  // Contraseña inicial opcional; si no se envía, el usuario queda con invitación pendiente.
  @IsOptional()
  @IsString()
  @MinLength(6)
  @MaxLength(200)
  password?: string;
}

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  sellerId?: string | null;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class LoginDto {
  // Login real: email + contraseña.
  @IsOptional()
  @IsString()
  @MaxLength(180)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  password?: string;

  // Compat (modo demo): el token es el id o email del usuario.
  @IsOptional()
  @IsString()
  @MaxLength(180)
  token?: string;
}

export class SetPasswordDto {
  @IsString()
  @MinLength(6)
  @MaxLength(200)
  password!: string;
}

export class ChangePasswordDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  currentPassword!: string;

  @IsString()
  @MinLength(6)
  @MaxLength(200)
  newPassword!: string;
}

export class RegisterPackDto {
  @IsString()
  @MinLength(1)
  @MaxLength(16)
  code!: string; // EA | CASE | PALLET | ...

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  barcode!: string;

  @IsInt()
  @IsPositive()
  factor!: number; // unidades base por pack

  @IsOptional()
  @IsString()
  @MaxLength(60)
  label?: string;
}

export class ScanInboundDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  barcode!: string;

  @IsInt()
  @IsPositive()
  packCount!: number;

  @IsOptional()
  @IsString()
  locationId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  locationCode?: string;

  @IsOptional()
  @IsString()
  lot?: string;

  @IsOptional()
  @IsString()
  expiry?: string;
}

export class ScanPutawayDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  productBarcode!: string;

  @IsInt()
  @IsPositive()
  packCount!: number;

  @IsString()
  @MinLength(1)
  @MaxLength(32)
  fromLocationCode!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(32)
  toLocationCode!: string;

  @IsOptional()
  @IsString()
  lot?: string;
}

export class ScanPickDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  productBarcode!: string;

  @IsInt()
  @IsPositive()
  packCount!: number;

  @IsString()
  @MinLength(1)
  @MaxLength(32)
  locationCode!: string;

  @IsOptional()
  @IsString()
  lot?: string;
}

export class CreateOperationDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  id?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;
}

/** Marca (white-label) de una operación. Todos los campos son opcionales. */
export class UpdateBrandingDto {
  @IsOptional() @IsString() @MaxLength(120) companyName?: string | null;
  @IsOptional() @IsString() @MaxLength(160) legalName?: string | null;
  @IsOptional() @IsString() @MaxLength(40) taxId?: string | null;
  @IsOptional() @IsString() @MaxLength(240) address?: string | null;
  @IsOptional() @IsString() @MaxLength(160) email?: string | null;
  @IsOptional() @IsString() @MaxLength(60) phone?: string | null;
  @IsOptional() @IsString() @MaxLength(160) website?: string | null;
  @IsOptional() @IsString() @MaxLength(9) primaryColor?: string | null;
  // Logo embebido (data URI). Límite alto; el dominio valida el tamaño real.
  @IsOptional() @IsString() @MaxLength(400000) logoDataUri?: string | null;
}

export class CreateSellerDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  id?: string;

  // Solo la usa el PLATFORM_ADMIN; el staff de operación la toma de su sesión.
  @IsOptional()
  @IsString()
  @MaxLength(64)
  operationId?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsEnum(PickingStrategy)
  pickingStrategy?: PickingStrategy;

  @IsOptional()
  @IsEnum(CycleCountStrategy)
  cycleCountStrategy?: CycleCountStrategy;

  @IsOptional()
  @IsBoolean()
  consolidateByLocation?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  courierPriority?: string[];

  @IsOptional()
  @IsBoolean()
  autoAllocateOnIngest?: boolean;
}

export class UpdateSellerPolicyDto {
  @IsOptional()
  @IsEnum(PickingStrategy)
  pickingStrategy?: PickingStrategy;

  @IsOptional()
  @IsEnum(CycleCountStrategy)
  cycleCountStrategy?: CycleCountStrategy;

  @IsOptional()
  @IsBoolean()
  consolidateByLocation?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  courierPriority?: string[];

  @IsOptional()
  @IsBoolean()
  autoAllocateOnIngest?: boolean;
}

export class UpdateSellerDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsEnum(PickingStrategy)
  pickingStrategy?: PickingStrategy;

  @IsOptional()
  @IsEnum(CycleCountStrategy)
  cycleCountStrategy?: CycleCountStrategy;

  @IsOptional()
  @IsBoolean()
  consolidateByLocation?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  courierPriority?: string[];

  @IsOptional()
  @IsBoolean()
  autoAllocateOnIngest?: boolean;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class CountLineDto {
  @IsString()
  @MinLength(1)
  sku!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  lot?: string;

  @IsInt()
  countedQty!: number;
}

export class PerformCountDto {
  @IsString()
  @MinLength(1)
  locationId!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CountLineDto)
  counted!: CountLineDto[];
}

export class CreateSkuDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  sku!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(240)
  description!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  barcode?: string;

  @IsOptional()
  @IsBoolean()
  lotControlled?: boolean;

  @IsOptional()
  @IsBoolean()
  serialControlled?: boolean;

  @IsOptional()
  @IsBoolean()
  expiryControlled?: boolean;

  @IsOptional()
  @IsEnum(RotationClass)
  rotationClass?: RotationClass;
}

export class CreateLocationDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  operationId?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(32)
  code!: string;

  @IsEnum(ZoneType)
  zoneType!: ZoneType;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  warehouseId?: string;

  // Capacidad en unidades (0 = sin límite definido).
  @IsOptional()
  @IsInt()
  capacity?: number;

  // Cercanía a picking: 1 = más cerca (mejor para clase A).
  @IsOptional()
  @IsInt()
  pickRank?: number;
}

export class UpdateLocationDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  code?: string;

  @IsOptional()
  @IsEnum(ZoneType)
  zoneType?: ZoneType;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  warehouseId?: string;

  @IsOptional()
  @IsInt()
  capacity?: number;

  @IsOptional()
  @IsInt()
  pickRank?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class PickTaskDto {
  @IsString()
  @MinLength(1)
  sku!: string;

  @IsString()
  @MinLength(1)
  locationId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  lot?: string;

  @IsOptional()
  @IsInt()
  @IsPositive()
  qty?: number;
}

export class UpdateOperationDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class ReceiveDto {
  @IsString()
  @MinLength(1)
  sku!: string;

  @IsInt()
  @IsPositive()
  qty!: number;

  @IsString()
  @MinLength(1)
  locationId!: string;

  @IsOptional()
  @IsString()
  lot?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  expiry?: string; // ISO — vencimiento del lote (habilita FEFO)

  @IsOptional()
  @IsEnum(Uom)
  uom?: Uom;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  reference?: string;
}

export class PutawayDto {
  @IsString()
  @MinLength(1)
  sku!: string;

  @IsInt()
  @IsPositive()
  qty!: number;

  @IsString()
  @MinLength(1)
  fromLocationId!: string;

  @IsString()
  @MinLength(1)
  toLocationId!: string;

  @IsOptional()
  @IsString()
  lot?: string;

  @IsOptional()
  @IsEnum(Uom)
  uom?: Uom;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  reference?: string;
}

// ---- Órdenes ----------------------------------------------------------------

export class ShipToDto {
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name!: string;

  @IsOptional() @IsString() @MaxLength(40)
  phone?: string;

  @IsOptional() @IsString() @MaxLength(160)
  email?: string;

  @IsOptional() @IsString() @MaxLength(240)
  address?: string;

  @IsOptional() @IsString() @MaxLength(120)
  comuna?: string;

  @IsOptional() @IsString() @MaxLength(120)
  region?: string;
}

export class OrderLineDto {
  @IsString()
  @MinLength(1)
  sku!: string;

  @IsInt()
  @IsPositive()
  qty!: number;

  // El contrato de ingreso del OMS usa "unit" (each | case | pallet).
  @IsOptional()
  @IsEnum(Uom)
  unit?: Uom;

  // Opcional: exige reservar de un lote/serie específico.
  @IsOptional()
  @IsString()
  @MaxLength(64)
  lot?: string;
}

export class CreateOrderDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  externalOrderId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  salesChannel!: string;

  @IsOptional()
  @IsEnum(OrderType)
  orderType?: OrderType;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  purchaseOrderRef?: string;

  // Atributo seleccionable de la orden (no emite ante el SII).
  @IsOptional()
  @IsIn(['boleta', 'factura', 'guia_despacho', 'orden_compra'])
  documentType?: string;

  // Courier/transporte con que llega la orden (texto libre: Chilexpress, Rapiboy, DHL…).
  @IsOptional()
  @IsString()
  @MaxLength(64)
  carrier?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  priority?: string;

  @ValidateNested()
  @Type(() => ShipToDto)
  shipTo!: ShipToDto;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderLineDto)
  lines!: OrderLineDto[];
}

/** Carga masiva de órdenes: archivo .xlsx/.csv codificado en base64. */
export class ImportOrdersDto {
  @IsString()
  @MinLength(1)
  dataBase64!: string;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  filename?: string;
}

// ---- Devoluciones ----------------------------------------------------------

export class CreateReturnDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  originalOrderRef!: string; // N° de la orden de salida original

  @IsOptional()
  @IsString()
  @MaxLength(240)
  reason?: string;
}

export class ProcessReturnLineDto {
  @IsString()
  @MinLength(1)
  sku!: string;

  @IsOptional() @IsInt() @Min(0)
  toStock?: number;

  @IsOptional() @IsInt() @Min(0)
  toMerma?: number;

  @IsOptional() @IsInt() @Min(0)
  toQuarantine?: number;

  @IsOptional() @IsString() @MaxLength(240)
  note?: string;
}

/** Archivo (.xlsx/.csv) en base64 para import genérico (productos, etc.). */
export class ImportFileDto {
  @IsString()
  @MinLength(1)
  dataBase64!: string;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  filename?: string;
}

/** Código escaneado (GS1 o plano) para interpretar en recepción. */
export class ScanCodeDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  code!: string;
}

export class ProcessReturnDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProcessReturnLineDto)
  lines!: ProcessReturnLineDto[];

  @IsOptional()
  @IsBoolean()
  close?: boolean;
}

export class ShipDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  carrier?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  trackingNumber?: string;
}

/** Empaque de una orden: cantidad de bultos embalados. */
export class PackMaterialDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  sku!: string;

  @IsInt()
  @IsPositive()
  qty!: number;
}

export class PackOrderDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(999)
  bultos?: number;

  // Insumos de embalaje consumidos al empacar (opcional).
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PackMaterialDto)
  materials?: PackMaterialDto[];
}

// ---- Insumos de embalaje (packaging, nivel operación) ----------------------
export class CreatePackagingDto {
  // Solo la usa el PLATFORM_ADMIN; el staff de operación la toma de su sesión.
  @IsOptional()
  @IsString()
  @MaxLength(64)
  operationId?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  sku!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  barcode?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  unitPrice?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class UpdatePackagingDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  barcode?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  unitPrice?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class PackagingSellerPriceDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  sellerId!: string;

  // null / omitido = borrar el override (vuelve al precio por defecto).
  @IsOptional()
  @IsInt()
  @Min(0)
  price?: number | null;
}

export class PackagingStockDto {
  @IsInt()
  qty!: number;
}

/** Una etiqueta que el OMS devuelve para un bulto. */
export class ShippingLabelDto {
  @IsInt() @Min(1) bultoNo!: number;

  @IsOptional() @IsString() @MaxLength(120) trackingNumber?: string | null;

  @IsOptional() @IsString() @MaxLength(64) carrier?: string | null;

  @IsOptional() @IsIn(['SVG', 'PNG', 'PDF', 'ZPL']) format?: 'SVG' | 'PNG' | 'PDF' | 'ZPL';

  // data: URI de la etiqueta imprimible (puede ser grande: SVG/PNG/PDF en base64).
  @IsString() @MaxLength(2_000_000) dataUri!: string;
}

/** Callback del OMS: tracking + etiquetas de una orden empacada. */
export class AttachLabelsDto {
  @IsOptional() @IsString() @MaxLength(120) trackingNumber?: string;

  @IsOptional() @IsString() @MaxLength(64) carrier?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ShippingLabelDto)
  labels?: ShippingLabelDto[];
}

// ---- Órdenes de recepción (inbound) ---------------------------------------
export class ReceiptLineDto {
  @IsString()
  @MinLength(1)
  sku!: string;

  @IsInt()
  @IsPositive()
  qty!: number;

  @IsOptional()
  @IsEnum(Uom)
  uom?: Uom;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  lot?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  expiry?: string; // ISO — vencimiento del lote (habilita FEFO)
}

export class CreateReceiptDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  supplier?: string; // proveedor

  @IsOptional()
  @IsString()
  @MaxLength(120)
  reference?: string; // guía / factura / OC del proveedor

  @IsOptional()
  @IsString()
  @MinLength(1)
  locationId?: string; // ubicación de recepción; default: primera RECEIVING

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReceiptLineDto)
  lines!: ReceiptLineDto[];
}

export class ReceiptCountDto {
  @IsInt()
  @IsPositive()
  lineNo!: number;

  @IsInt()
  qty!: number; // recibido en este evento (>= 0)

  @IsOptional()
  @IsString()
  @MaxLength(64)
  lot?: string; // lote capturado/confirmado en la recepción

  @IsOptional()
  @IsString()
  @MaxLength(32)
  expiry?: string; // vencimiento (YYYY-MM-DD)

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  serials?: string[]; // números de serie de las unidades recibidas
}

export class ReceiveCountsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReceiptCountDto)
  counts!: ReceiptCountDto[];
}

// ---- Mantenedor de productos (SKUs + kits) --------------------------------
export class KitComponentDto {
  @IsString()
  @MinLength(1)
  sku!: string;

  @IsInt()
  @IsPositive()
  qty!: number;
}

export class CreateProductDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  sku!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(160)
  description!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  barcode?: string;

  @IsOptional()
  @IsBoolean()
  lotControlled?: boolean;

  @IsOptional()
  @IsBoolean()
  serialControlled?: boolean;

  @IsOptional()
  @IsBoolean()
  expiryControlled?: boolean;

  @IsOptional()
  @IsEnum(RotationClass)
  rotationClass?: RotationClass;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsBoolean()
  isKit?: boolean;

  @IsOptional()
  @IsEnum(KitMode)
  kitMode?: KitMode;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => KitComponentDto)
  components?: KitComponentDto[];
}

export class UpdateProductDto {
  @IsOptional()
  @IsString()
  @MaxLength(160)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  barcode?: string;

  @IsOptional()
  @IsBoolean()
  lotControlled?: boolean;

  @IsOptional()
  @IsBoolean()
  serialControlled?: boolean;

  @IsOptional()
  @IsBoolean()
  expiryControlled?: boolean;

  @IsOptional()
  @IsEnum(RotationClass)
  rotationClass?: RotationClass;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsBoolean()
  isKit?: boolean;

  @IsOptional()
  @IsEnum(KitMode)
  kitMode?: KitMode;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => KitComponentDto)
  components?: KitComponentDto[];
}

export class AssembleSourceDto {
  @IsString()
  @MinLength(1)
  sku!: string;

  @IsString()
  @MinLength(1)
  locationId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  lot?: string;

  @IsInt()
  @IsPositive()
  qty!: number;
}

export class AssembleKitDto {
  @IsInt()
  @IsPositive()
  qty!: number;

  @IsString()
  @MinLength(1)
  toLocationId!: string;

  // De qué ubicación (y lote) sale cada componente — lo elige el usuario, no se asume.
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AssembleSourceDto)
  sources!: AssembleSourceDto[];
}

// ---- Facturación 3PL ------------------------------------------------------
export class SetRateDto {
  @IsOptional() @IsString() @MaxLength(8) currency?: string;
  @IsOptional() @IsInt() fixedMonthly?: number;
  @IsOptional() @IsInt() storagePerUnitMonth?: number;
  @IsOptional() @IsInt() receiptPerUnit?: number;
  @IsOptional() @IsInt() shipmentPerOrder?: number;
  @IsOptional() @IsInt() pickPerUnit?: number;
  @IsOptional() @IsInt() assemblyPerKit?: number;
  @IsOptional() @IsBoolean() requiresApproval?: boolean;
}

export class GenerateInvoiceDto {
  @IsInt() year!: number;
  @IsInt() month!: number; // 1-12
}

export class InvoiceLineDto {
  @IsString() @MinLength(1) @MaxLength(80) concept!: string;
  @IsOptional() @IsString() @MaxLength(24) unit?: string;
  @IsInt() qty!: number;
  @IsInt() rate!: number;
}

export class UpdateInvoiceDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(40) number?: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => InvoiceLineDto) lines?: InvoiceLineDto[];
}

export class SendInvoiceDto {
  @IsEmail() to!: string;
}

/** Adjuntar el documento tributario (factura real en PDF u otro archivo) a una factura. */
export class AttachTaxDocDto {
  @IsString() @MinLength(1) @MaxLength(255) fileName!: string;

  @IsOptional() @IsString() @MaxLength(120) mimeType?: string;

  // Contenido del archivo en base64 (admite prefijo data: URI). ~28 MB base64 ≈ 20 MB de archivo.
  @IsString() @MinLength(1) @MaxLength(30_000_000) contentBase64!: string;

  @IsOptional() @IsBoolean() markInvoiced?: boolean;
}

export class SendChatMessageDto {
  @IsString() @MinLength(1) @MaxLength(2000) body!: string;
}

export class CreateAnnouncementDto {
  @IsString() @MinLength(1) @MaxLength(240) title!: string;
  @IsString() @MinLength(3) @MaxLength(500) linkUrl!: string;
  @IsOptional() @IsString() @MaxLength(40) linkLabel?: string;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsIn(['OPS', 'ALL']) audience?: 'OPS' | 'ALL';
}

export class UpdateAnnouncementDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(240) title?: string;
  @IsOptional() @IsString() @MinLength(3) @MaxLength(500) linkUrl?: string;
  @IsOptional() @IsString() @MaxLength(40) linkLabel?: string;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsIn(['OPS', 'ALL']) audience?: 'OPS' | 'ALL';
}

// ---- Webhooks configurables por evento ------------------------------------
const WEBHOOK_EVENTS = [
  'order.allocated',
  'order.picking',
  'order.picked',
  'order.packed',
  'order.shipped',
  'order.cancelled',
  'reception.received',
] as const;
type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export class CreateWebhookDto {
  @IsString() @MinLength(3) @MaxLength(500) url!: string;

  @IsArray()
  @IsIn(WEBHOOK_EVENTS, { each: true })
  events!: WebhookEvent[];
}

export class UpdateWebhookDto {
  @IsOptional() @IsString() @MinLength(3) @MaxLength(500) url?: string;

  @IsOptional()
  @IsArray()
  @IsIn(WEBHOOK_EVENTS, { each: true })
  events?: WebhookEvent[];

  @IsOptional() @IsBoolean() active?: boolean;
}

export class WebhookAccessDto {
  @IsBoolean() enabled!: boolean;
}

// ---- Canal de voz operador↔admin ------------------------------------------
export class SendOpsMessageDto {
  // Operación destino (plataforma/demo). El staff de operación usa la suya.
  @IsOptional() @IsString() @MaxLength(64) operationId?: string;

  // Hilo (operador dueño). El admin lo indica al responder; el operador se ata al suyo.
  @IsOptional() @IsString() @MaxLength(64) threadUserId?: string;

  @IsIn(['voice', 'text']) kind!: 'voice' | 'text';

  @IsOptional() @IsString() @MaxLength(4000) text?: string | null;

  @IsOptional() @IsString() @MaxLength(4000) note?: string | null;

  // Audio en base64 (para kind=voice). Puede ser grande (≈ hasta ~3.5 MB base64).
  @IsOptional() @IsString() @MaxLength(5_000_000) audioBase64?: string | null;

  @IsOptional() @IsString() @MaxLength(80) audioMime?: string | null;

  @IsOptional() @IsInt() @Min(0) @Max(3600) durationSec?: number | null;
}

export class OpsReadDto {
  @IsOptional() @IsString() @MaxLength(64) operationId?: string;

  @IsOptional() @IsString() @MaxLength(64) threadUserId?: string;
}

// ---- Copiloto -------------------------------------------------------------
export class CopilotTurnDto {
  @IsIn(['user', 'assistant']) role!: 'user' | 'assistant';

  @IsString() @MaxLength(6000) content!: string;
}
export class CopilotAskDto {
  @IsOptional() @IsString() @MaxLength(64) operationId?: string;

  @IsOptional() @IsString() @MaxLength(64) sellerId?: string;

  @IsString() @MinLength(1) @MaxLength(1000) question!: string;

  // Historial de la conversación (turnos previos) para continuar el hilo.
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CopilotTurnDto)
  history?: CopilotTurnDto[];
}

export class AiConfigDto {
  @IsOptional() @IsString() @MaxLength(64) operationId?: string;

  @IsOptional() @IsString() @MaxLength(64) sellerId?: string;

  @IsOptional() @IsString() @MaxLength(40) provider?: string;

  @IsOptional() @IsString() @MaxLength(300) baseUrl?: string;

  @IsOptional() @IsString() @MaxLength(80) chatModel?: string;

  @IsString() @MinLength(8) @MaxLength(300) apiKey!: string;
}

/** Grant manual de plan por el super-admin (PLG · Fase 1). */
export class PlanDto {
  @IsOptional() @IsString() @MaxLength(64) operationId?: string;

  @IsIn(['free', 'growth', 'scale', 'enterprise', 'internal']) planId!: string;
}

/** Límites de un plan en el mantenedor (null = ilimitado). */
export class PlanLimitsDto {
  @IsOptional() ordersPerMonth?: number | null;
  @IsOptional() sellers?: number | null;
  @IsOptional() users?: number | null;
  @IsOptional() warehouses?: number | null;
}

/** Tarifas mensuales por plan (null = a medida). */
export class PlanPricesDto {
  @IsOptional() usd?: number | null;
  @IsOptional() clp?: number | null;
}

/** Config editable de un plan en la matriz módulo × plan (super-admin). */
export class PlanConfigDto {
  @IsOptional() @IsString() @MaxLength(60) name?: string;

  @IsOptional() @ValidateNested() @Type(() => PlanPricesDto) prices?: PlanPricesDto;

  @IsOptional() @IsString() @MaxLength(200) blurb?: string;

  @IsOptional() @IsArray() @IsString({ each: true }) features?: string[];

  @IsOptional() @ValidateNested() @Type(() => PlanLimitsDto) limits?: PlanLimitsDto;
}

/** Alta self-serve (PLG · Fase 0): crea operación + admin + (marca) seller por defecto. */
export class RegisterDto {
  @IsString() @MinLength(1) @MaxLength(120) companyName!: string;

  @IsString() @MinLength(1) @MaxLength(120) name!: string;

  @IsEmail() @MaxLength(160) email!: string;

  @IsString() @MinLength(6) @MaxLength(200) password!: string;

  @IsIn(['brand', 'operator']) track!: 'brand' | 'operator';
}

export class VerifyEmailDto {
  @IsString() @MinLength(8) @MaxLength(200) token!: string;
}

export class EmailOnlyDto {
  @IsEmail() @MaxLength(160) email!: string;
}

export class ResetPasswordDto {
  @IsString() @MinLength(8) @MaxLength(200) token!: string;

  @IsString() @MinLength(6) @MaxLength(200) password!: string;
}

/** Confirmación de una acción de escritura propuesta por el copiloto (modo 'confirm'). */
export class CopilotConfirmActionDto {
  @IsOptional() @IsString() @MaxLength(64) operationId?: string;

  @IsOptional() @IsString() @MaxLength(64) sellerId?: string;

  @IsString() @MinLength(1) @MaxLength(120) orden!: string;

  @IsIn(['reservar', 'iniciar_picking', 'pickear', 'empacar', 'despachar']) accion!: string;
}

/** Ajuste del modo de acciones del copiloto por operación. */
export class CopilotSettingsDto {
  @IsOptional() @IsString() @MaxLength(64) operationId?: string;

  @IsIn(['confirm', 'direct']) actionMode!: 'confirm' | 'direct';
}
