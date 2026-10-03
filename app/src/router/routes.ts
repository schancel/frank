import type { RouteRecordRaw } from 'vue-router'

export function createRoutes(): RouteRecordRaw[] {
  const routes: RouteRecordRaw[] = [
    {
      path: '/',
      // Ticket #61 made Forum the primary nav surface (flat Topics hidden from nav in favor of
      // it) -- this root redirect was never updated to match and still sent every fresh load,
      // and every "Contacts" tab click (LeftDrawer.vue's `@click="$router.push('/')"`), to the
      // old, unmigrated, Lotus/XPI-labeled flat Topics view instead.
      redirect: '/forum',
      component: () => import('layouts/MainLayout.vue'),
      children: [
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
        {
          path: 'chat',
          component: () => import('layouts/ChatLayout.vue'),
          children: [
            { path: ':address', component: () => import('pages/Chat.vue') },
          ],
        },
        { path: 'settings', component: () => import('pages/Settings.vue') },
        { path: 'profile', component: () => import('pages/Profile.vue') },
        { path: 'receive', component: () => import('pages/Receive.vue') },
        { path: 'send', component: () => import('pages/Send.vue') },
        { path: 'wallet', component: () => import('pages/Wallet.vue') },
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
