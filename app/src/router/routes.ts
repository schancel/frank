import type { RouteRecordRaw } from 'vue-router'
import { accountStatus } from '../accounts/session'

export function createRoutes(): RouteRecordRaw[] {
  const routes: RouteRecordRaw[] = [
    {
      path: '/',
      redirect: () =>
        accountStatus.status === 'ready' ? '/forum' : '/welcome',
      component: () => import('layouts/MainLayout.vue'),
      children: [
        {
          path: 'welcome',
          component: () => import('pages/Welcome.vue'),
        },
        {
          path: 'forum',
          component: () => import('layouts/ForumLayout.vue'),
          children: [
            { path: '', component: () => import('pages/Forum.vue') },
            {
              path: ':payloadDigest',
              component: () => import('pages/ForumPost.vue'),
            },
            {
              path: '/new-post',
              component: () => import('pages/CreatePost.vue'),
            },
            {
              path: '/new-post/:parentDigest',
              component: () => import('pages/CreatePost.vue'),
            },
          ],
        },
        {
          path: 'topic',
          component: () => import('layouts/TopicLayout.vue'),
          children: [
            {
              path: ':topic',
              component: () => import('pages/Topic.vue'),
            },
          ],
        },
        { path: 'agora', redirect: '/forum' },
        { path: 'changelog', component: () => import('pages/Changelog.vue') },
        { path: 'docs', component: () => import('pages/DocsView.vue') },
        { path: 'about', component: () => import('pages/About.vue') },
        {
          path: 'chat',
          component: () => import('layouts/ChatLayout.vue'),
          children: [
            { path: '', component: () => import('pages/ChatPlaceholder.vue') },
            { path: ':address', component: () => import('pages/Chat.vue') },
          ],
        },
        { path: 'settings', component: () => import('pages/Settings.vue') },
        { path: 'backup', component: () => import('pages/BackupAccount.vue') },
        { path: 'backup-account', redirect: '/backup' },
        { path: 'profile', component: () => import('pages/Profile.vue') },
        { path: 'receive', redirect: '/wallet' },
        { path: 'send', component: () => import('pages/Send.vue') },
        {
          path: 'send-contact',
          component: () => import('pages/SendContact.vue'),
        },
        {
          path: 'wallet/:wallet?',
          component: () => import('pages/Wallet.vue'),
        },
        {
          path: 'add-contact',
          component: () => import('pages/AddContact.vue'),
        },
        {
          path: 'add-topic',
          component: () => import('pages/AddTopic.vue'),
        },
        { path: 'setup', component: () => import('pages/Setup.vue') },
        {
          path: 'wipe-wallet',
          redirect: '/settings',
        },
      ],
    },
  ]
  return routes
}
