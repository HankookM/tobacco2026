// Cloudflare Pages Functions catch-all for /api/*
// 정적 자산은 Pages가 자동 서빙, /api/* 요청은 이 핸들러가 처리.
import worker from '../_lib/api.js';

export const onRequest = async (ctx) => {
  return worker.fetch(ctx.request, ctx.env);
};
