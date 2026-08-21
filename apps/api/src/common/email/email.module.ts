import { Module } from '@nestjs/common';
import { EmailService } from './email.service';

/**
 * Email, as a module rather than a provider on AppModule.
 *
 * It became one when alerting needed to send from inside ObservabilityModule
 * (docs/42 §3): a provider registered on AppModule is not visible to a module
 * AppModule imports, and the alternative — listing EmailService in a second
 * module's providers — would build a second nodemailer transport, so the
 * platform would hold two SMTP connection pools and nobody would know which
 * one a given message left by.
 */
@Module({
  providers: [EmailService],
  exports: [EmailService],
})
export class EmailModule {}
