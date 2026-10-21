import type { RouteRecordRaw } from 'vue-router'
import { accountStatus } from '../accounts/session'
import { resolveSavedExtensionRoute } from './extension-route-persistence'
import AvuDetails from '../pages/AvuDetails.vue'

export function createRoutes(): RouteRecordRaw[] {
  const routes: RouteRecordRaw[] = [
    {
      path: '/',
      redirect: () =>
        accountStatus.status === 'ready'
          ? resolveSavedExtensionRoute() ?? '/forum'
          : '/welcome',
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
          path: 'avu',
          component: () => Promise.resolve({ default: AvuDetails }),
        },
        {
          path: 'chat',
          component: () => import('layouts/ChatLayout.vue'),
          children: [
            { path: '', component: () => import('pages/ChatPlaceholder.vue') },
            { path: ':address', component: () => import('pages/Chat.vue') },
          ],
        },
        // One component for the list and every section (/settings/networking, ...): a phone
        // shows one of them per route, a wide layout shows the list beside the section.
        {
          path: 'settings/:section?',
          component: () => import('pages/Settings.vue'),
        },
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
          path: 'new-conversation',
          component: () => import('pages/AddContact.vue'),
        },
        {
          path: 'add-contact',
          component: () => import('pages/AddContact.vue'),
        },
        {
          path: 'qr',
          component: () => import('pages/IdentityQrPage.vue'),
        },
        {
          path: 'add-topic',
          component: () => import('pages/AddTopic.vue'),
        },
        { path: 'setup', component: () => import('pages/Setup.vue') },
        { path: 'onboard', component: () => import('pages/Onboard.vue') },
        {
          path: 'dapp-bridge',
          component: () => import('pages/DappBridge.vue'),
        },
        {
          path: 'claim=:token(.*)',
          redirect: to => ({
            path: '/onboard',
            hash: `#claim=${String(to.params.token || '')}`,
          }),
        },
      ],
    },
  ]
  return routes
}
