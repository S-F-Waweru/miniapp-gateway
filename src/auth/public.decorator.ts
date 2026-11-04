import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'isPublic';
/** Opts a route out of ServiceAuthGuard. Use only for Safaricom callbacks and dev tools. */
export const Public = () => SetMetadata(IS_PUBLIC, true);
