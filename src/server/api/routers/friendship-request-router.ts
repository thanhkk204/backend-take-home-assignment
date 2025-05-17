import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { FriendshipStatusSchema } from '@/utils/server/friendship-schemas'
import { authGuard } from '@/server/trpc/middlewares/auth-guard'
import { procedure } from '@/server/trpc/procedures'
import { IdSchema } from '@/utils/server/base-schemas'
import { router } from '@/server/trpc/router'

const SendFriendshipRequestInputSchema = z.object({
  friendUserId: IdSchema,
})

const canSendFriendshipRequest = authGuard.unstable_pipe(
  async ({ ctx, rawInput, next }) => {
    const { friendUserId } = SendFriendshipRequestInputSchema.parse(rawInput)

    await ctx.db
      .selectFrom('users')
      .where('users.id', '=', friendUserId)
      .select('id')
      .limit(1)
      .executeTakeFirstOrThrow(
        () =>
          new TRPCError({
            code: 'BAD_REQUEST',
          })
      )

    return next({ ctx })
  }
)

const AnswerFriendshipRequestInputSchema = z.object({
  friendUserId: IdSchema,
})

const canAnswerFriendshipRequest = authGuard.unstable_pipe(
  async ({ ctx, rawInput, next }) => {
    const { friendUserId } = AnswerFriendshipRequestInputSchema.parse(rawInput)

    await ctx.db
      .selectFrom('friendships')
      .where('friendships.userId', '=', friendUserId)
      .where('friendships.friendUserId', '=', ctx.session.userId)
      .where(
        'friendships.status',
        '=',
        FriendshipStatusSchema.Values['requested']
      )
      .select('friendships.id')
      .limit(1)
      .executeTakeFirstOrThrow(() => {
        throw new TRPCError({
          code: 'BAD_REQUEST',
        })
      })

    return next({ ctx })
  }
)

export const friendshipRequestRouter = router({
   send: procedure
    .use(canSendFriendshipRequest)
    .input(SendFriendshipRequestInputSchema)
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db
        .selectFrom('friendships')
        .selectAll()
        .where('userId', '=', ctx.session.userId)
        .where('friendUserId', '=', input.friendUserId)
        .executeTakeFirst()

      if (existing) {
        if (existing.status === FriendshipStatusSchema.Values['declined']) {
          // Nếu từng bị declined → update thành requested
          await ctx.db
            .updateTable('friendships')
            .set({ status: FriendshipStatusSchema.Values['requested'] })
            .where('userId', '=', ctx.session.userId)
            .where('friendUserId', '=', input.friendUserId)
            .execute()
        } else {
          // Các trường hợp khác (đã requested, accepted, ...) → throw error
          throw new Error('Friendship already exists')
        }
      } else {
        // Nếu chưa tồn tại → insert mới
        await ctx.db
          .insertInto('friendships')
          .values({
            userId: ctx.session.userId,
            friendUserId: input.friendUserId,
            status: FriendshipStatusSchema.Values['requested'],
          })
          .execute()
      }
    }),

 accept: procedure
    .use(canAnswerFriendshipRequest)
    .input(AnswerFriendshipRequestInputSchema)
    .mutation(async ({ ctx, input }) => {
      await ctx.db.transaction().execute(async (t) => {
        // Cập nhật lại bảng friendShip của người gửi
        await t
          .updateTable('friendships')
          .set({ status: FriendshipStatusSchema.Values['accepted'] })
          .where('userId', '=', input.friendUserId)
          .where('friendUserId', '=', ctx.session.userId)
          .execute()
        // Cập nhật lại bảng friendShip của người ấn
        await t
          .updateTable('friendships')
          .set({ status: FriendshipStatusSchema.Values['accepted'] })
          .where('userId', '=', ctx.session.userId)
          .where('friendUserId', '=', input.friendUserId)
          .execute()

        // Tạo bản ghi kết bạn chiều ngược lại nếu chưa có
        await t
          .insertInto('friendships')
          .values({
            userId: ctx.session.userId,
            friendUserId: input.friendUserId,
            status: FriendshipStatusSchema.Values['accepted'],
          })
          .onConflict((oc) =>
            oc.columns(['userId', 'friendUserId']).doNothing()
          )
          .execute()
      })
    }),

  decline: procedure
    .use(canAnswerFriendshipRequest)
    .input(AnswerFriendshipRequestInputSchema)
    .mutation(async ({ ctx, input }) => {
       await ctx.db.connection().execute(async (t) => {
        await t
          .updateTable('friendships')
          .set({ status: FriendshipStatusSchema.Values['declined'] })
          .where('userId', '=', input.friendUserId) // Người gửi lời mời
          .where('friendUserId', '=', ctx.session.userId) // Người đang decline (tức là B)
          .where('status', '=', FriendshipStatusSchema.Values['requested'])
          .execute()
      })
    }),
})
