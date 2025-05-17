import type { Database } from '@/server/db'

import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { FriendshipStatusSchema } from '@/utils/server/friendship-schemas'
import { protectedProcedure } from '@/server/trpc/procedures'
import { router } from '@/server/trpc/router'
import {
  NonEmptyStringSchema,
  CountSchema,
  IdSchema,
} from '@/utils/server/base-schemas'

export const myFriendRouter = router({
   getById: protectedProcedure
    .input(z.object({ friendUserId: IdSchema }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.connection().execute(async (conn) => {
        // Subquery để đếm bạn chung
        const mutualFriendsSubquery = conn
          .selectFrom('friendships as f1')
          .innerJoin('friendships as f2', (join) =>
            join
              .onRef('f1.friendUserId', '=', 'f2.friendUserId')
              .on('f2.userId', '=', input.friendUserId)
          )
          .where('f1.userId', '=', ctx.session.userId)
          .where('f1.status', '=', 'accepted')
          .where('f2.status', '=', 'accepted')
          .select((eb) =>
            eb.fn.count('f1.friendUserId').as('mutualFriendCount')
          )

        return (
          conn
            .selectFrom('users as friends')
            .innerJoin('friendships', 'friendships.friendUserId', 'friends.id')
            .innerJoin(
              userTotalFriendCount(conn).as('userTotalFriendCount'),
              'userTotalFriendCount.userId',
              'friends.id'
            )
            // Thêm subquery đếm bạn chung
            .leftJoin(mutualFriendsSubquery.as('mutualFriends'), (join) =>
              join.onTrue()
            )
            .where('friendships.userId', '=', ctx.session.userId)
            .where('friendships.friendUserId', '=', input.friendUserId)
            .where('friendships.status', '=', 'accepted')
            .select([
              'friends.id',
              'friends.fullName',
              'friends.phoneNumber',
              'totalFriendCount',
              'mutualFriendCount', // Thêm kết quả từ subquery
            ])
            .executeTakeFirstOrThrow(() => new TRPCError({ code: 'NOT_FOUND' }))
            .then(
              z.object({
                id: IdSchema,
                fullName: NonEmptyStringSchema,
                phoneNumber: NonEmptyStringSchema,
                totalFriendCount: CountSchema,
                mutualFriendCount: CountSchema, // Xác thực kết quả
              }).parse
            )
        )
      })
    }),
})

const userTotalFriendCount = (db: Database) => {
  return db
    .selectFrom('friendships')
    .where('friendships.status', '=', FriendshipStatusSchema.Values['accepted'])
    .select((eb) => [
      'friendships.userId',
      eb.fn.count('friendships.friendUserId').as('totalFriendCount'),
    ])
    .groupBy('friendships.userId')
}
