import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { createWmsContext } from '../infra/context';
import { AuthGuard } from './auth/auth.guard';
import { BrandingController } from './branding.controller';
import { HealthController } from './health.controller';
import { InventoryController } from './inventory.controller';
import { LocationsController } from './locations.controller';
import { AiDashboardController } from './ai-dashboard.controller';
import { OperationsController } from './operations.controller';
import { PlatformController } from './platform.controller';
import { BillingController } from './billing.controller';
import { ChatController } from './chat.controller';
import { AnnouncementsController } from './announcements.controller';
import { WebhooksController } from './webhooks.controller';
import { WebhooksAdminController } from './webhooks-admin.controller';
import { OrdersController } from './orders.controller';
import { ConsigneesController } from './consignees.controller';
import { McpController } from './mcp.controller';
import { ApiKeysController } from './api-keys.controller';
import { OrdersImportController } from './orders-import.controller';
import { ReturnsController } from './returns.controller';
import { ProductsImportController } from './products-import.controller';
import { LocationsImportController } from './locations-import.controller';
import { ProductsController } from './products.controller';
import { ReceiptsController } from './receipts.controller';
import { ReceiptsImportController } from './receipts-import.controller';
import { PackagingController } from './packaging.controller';
import { OpsChannelController } from './ops-channel.controller';
import { CopilotController } from './copilot.controller';
import { ActivityController } from './activity.controller';
import { PlanController } from './plan.controller';
import { OnboardingController } from './onboarding.controller';
import { OrdersMaintenanceController } from './orders-maintenance.controller';
import { EventsController } from './events.controller';
import { AnalyticsController } from './analytics.controller';
import { AssignmentsController } from './assignments.controller';
import { AgentController } from './agent.controller';
import { CostsController } from './costs.controller';
import { SellersController } from './sellers.controller';
import { UsersController, AuthController } from './users.controller';
import { WMS_CONTEXT, WMS_FACADE, WMS_CLOCK } from './tokens';
import type { WmsContext } from '../infra/context';

@Module({
  controllers: [
    HealthController,
    BrandingController,
    AuthController,
    OperationsController,
    AiDashboardController,
    PlatformController,
    UsersController,
    SellersController,
    LocationsController,
    InventoryController,
    OrdersController,
    ConsigneesController,
    McpController,
    ApiKeysController,
    OrdersImportController,
    ReturnsController,
    ProductsController,
    ProductsImportController,
    LocationsImportController,
    BillingController,
    ChatController,
    AnnouncementsController,
    WebhooksController,
    WebhooksAdminController,
    ReceiptsController,
    ReceiptsImportController,
    PackagingController,
    OpsChannelController,
    CopilotController,
    ActivityController,
    PlanController,
    OnboardingController,
    OrdersMaintenanceController,
    EventsController,
    AnalyticsController,
    AssignmentsController,
    AgentController,
    CostsController,
  ],
  providers: [
    {
      provide: WMS_CONTEXT,
      // Async factory: arma el contexto (fachada + reloj) con la persistencia elegida por env.
      useFactory: async () => createWmsContext(),
    },
    {
      provide: WMS_FACADE,
      useFactory: (ctx: WmsContext) => ctx.facade,
      inject: [WMS_CONTEXT],
    },
    {
      provide: WMS_CLOCK,
      useFactory: (ctx: WmsContext) => ctx.clock,
      inject: [WMS_CONTEXT],
    },
    // Guard global: identidad + autorización por permiso en cada request.
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
