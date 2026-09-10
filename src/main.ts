import 'reflect-metadata';
import { join } from 'path';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './api/app.module';
import { DomainExceptionFilter } from './api/domain-exception.filter';
import { WMS_CLOCK, WMS_FACADE } from './api/tokens';
import type { MutableClock } from './infra/system';
import { seedDemo } from './infra/seed-demo';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ['log', 'warn', 'error'] });

  // Sube el límite del cuerpo JSON: la carga masiva de órdenes envía el Excel
  // en base64 y puede superar el límite por defecto (100kb).
  app.useBodyParser('json', { limit: '25mb' });

  // Sirve la PWA (carpeta pwa/) en /app, mismo origen que la API:
  // así un solo túnel HTTPS expone app + API y la cámara funciona (contexto seguro).
  app.useStaticAssets(join(__dirname, '..', '..', 'pwa'), { prefix: '/app' });

  // Sirve el panel de administración CONECTADO (carpeta webadmin/) en /admin,
  // mismo origen que la API. Necesario: los artifacts publicados en claude.ai
  // tienen CSP que bloquea llamadas a APIs externas; servido aquí, el panel
  // llama a la API en su propio origen sin restricción.
  app.useStaticAssets(join(__dirname, '..', '..', 'webadmin'), { prefix: '/admin' });

  // Assets de marca (white-label). El logo por defecto vive en webadmin/brand/,
  // pero se sirve también bajo `/brand` (independiente del prefijo /admin) para
  // que GET /branding pueda apuntar a una URL estable (`/brand/logo.svg`).
  // Para white-label: reemplaza el archivo del logo y ajusta BRAND_* por env.
  app.useStaticAssets(join(__dirname, '..', '..', 'webadmin', 'brand'), { prefix: '/brand' });

  // CORS: permite que la PWA (servida en otro origen) llame a la API.
  // En producción, restringe `origin` a los dominios de la app.
  app.enableCors({ origin: process.env.CORS_ORIGIN ?? true, allowedHeaders: ['Content-Type', 'Authorization', 'x-user-id'] });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // descarta campos no declarados en el DTO
      forbidNonWhitelisted: true,
      transform: true, // coacciona tipos (query strings -> number, etc.)
    }),
  );
  app.useGlobalFilters(new DomainExceptionFilter());

  // Semilla de demostración opcional (para pruebas rápidas / túnel).
  if (process.env.SEED_DEMO === 'true') {
    try {
      await seedDemo(app.get(WMS_FACADE), app.get<MutableClock>(WMS_CLOCK));
      // eslint-disable-next-line no-console
      console.log('Semilla de demostración cargada (seller acme, usuarios: admin, pedro, carla).');
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('No se pudo cargar la semilla de demostración:', (e as Error).message);
    }
  }

  // Materialización de rollups (G3) y derivación de LaborTasks (G4): tras el seed y
  // en cada arranque, para que el dashboard y el forecasting tengan datos frescos.
  try {
    const r = await (app.get(WMS_FACADE) as any).bootstrapAnalytics();
    // eslint-disable-next-line no-console
    console.log(`Analítica materializada (rollups + labor) para ${r.operations} operación(es).`);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('No se pudo materializar la analítica inicial:', (e as Error).message);
  }

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`PWA operador disponible en  http://localhost:${port}/app/`);
  // eslint-disable-next-line no-console
  console.log(`WMS escuchando en http://localhost:${port}  (persistencia: ${process.env.PERSISTENCE ?? 'memory'})`);
}

bootstrap();
