import { makeTypeSafeSchema, TypeSafeSchema } from '../model-utils';
import mongoose, { Document, Schema, Types } from 'mongoose';
import type { IOrganizationDoc, IOrganizationModel } from '../organization.model';
import User from '../user.model';
import Organization from '../organization.model';
import { ResponseError } from '../../services/utils/error.utils';
import { ORGANIZATION_NESTED_ENTITY_FIELDS, TEAM_ROLES } from './organization-models-access-control';
import { RestrictedDocument } from '../plugins/role-assignment/role-assignment';

const TEAM_UPDATABLE_FIELDS = ['name', 'logoPath'] as const;
export type ITeamUpdatableFields = Pick<ITeam, typeof TEAM_UPDATABLE_FIELDS[number]>;

export interface ITeam {
    name: string;
    logoPath?: string;
}

export interface ITeamDoc extends ITeam, Document<Types.ObjectId>, RestrictedDocument {
    id?: string;
}

export type ITeamJSON = ITeam & Pick<ITeamDoc, 'id' | 'accessControlList'>;

export const TeamSchema = makeTypeSafeSchema(
    new Schema<ITeamDoc>({
        name: { type: String, required: true },
        logoPath: { type: String }
    } as Record<keyof ITeam, any>)
);

export interface IOrganizationTeamDoc {
    getTeams(): Promise<ITeamDoc[] | undefined>;
}

export interface IOrganizationTeamModel {
    createTeam(id: Types.ObjectId, team: Partial<ITeamUpdatableFields>, creatorId: Types.ObjectId): Promise<IOrganizationDoc | null>;
    updateTeam(id: Types.ObjectId, teamId: Types.ObjectId, team: Partial<ITeamUpdatableFields>): Promise<IOrganizationDoc | null>;
    deleteTeam(id: Types.ObjectId, teamId: Types.ObjectId): Promise<void>;

    // team user membership
    addUserToTeam(id: Types.ObjectId, teamId: Types.ObjectId, userId: Types.ObjectId): Promise<void>;
    removeUserFromTeam(id: Types.ObjectId, teamId: Types.ObjectId, userId: Types.ObjectId): Promise<void>;

    teamForResponse(team: ITeamDoc): Promise<ITeamJSON>;
}

TeamSchema.set('toJSON', {
    virtuals: true,
    versionKey: false,
    transform: function (_doc: ITeamDoc, ret: ITeamJSON & Pick<ITeamDoc, '_id' | 'accessControlList'>) {
        delete ret._id;
    }
});

// Register team related methods of ISchema
export const registerOrganizationTeamFunctions = (
    OrganizationSchema: TypeSafeSchema<IOrganizationDoc, IOrganizationModel, Types.ObjectId>
): void => {
    OrganizationSchema.statics.teamForResponse = async function (team) {
        const teamInJSON = Object.assign({}, team.toJSON() as unknown as ITeamJSON);
        for (const acl of teamInJSON.accessControlList ?? []) {
            delete acl._id;
        }
        return teamInJSON;
    };

    OrganizationSchema.methods.getTeams = async function () {
        return this.teams;
    };
    OrganizationSchema.statics.createTeam = async function (id, team, creatorId) {
        const newTeam = team as ITeamDoc;
        newTeam._id = mongoose.Types.ObjectId();
        const updatedOrganization = await Organization.findOneAndUpdate(
            { _id: id },
            { $addToSet: { teams: newTeam } },
            { new: true, runValidators: true }
        );

        if (!updatedOrganization) throw new ResponseError('NotFound');

        // grant creator admin role
        return Organization.setNestedUserRole(
            updatedOrganization.id!,
            ORGANIZATION_NESTED_ENTITY_FIELDS.teams,
            newTeam._id.toString(),
            TEAM_ROLES.TEAM_ADMIN,
            creatorId
        );
    };
    OrganizationSchema.statics.updateTeam = async function (id, teamId, team) {
        const newTeamInput = team as Record<string, any>;
        const newTeamFieldSet: Record<string, any> = {};

        TEAM_UPDATABLE_FIELDS.forEach((key) => {
            if (newTeamInput[key]) {
                newTeamFieldSet[`teams.$.${key}`] = newTeamInput[key];
            }
        });
        return Organization.findOneAndUpdate({ _id: id, 'teams._id': teamId }, { $set: newTeamFieldSet }, { new: true });
    };
    OrganizationSchema.statics.deleteTeam = async function (id, teamId) {
        await Organization.findOneAndUpdate({ _id: id, 'teams._id': teamId }, { $pull: { teams: { _id: teamId } } });

        // delete all user membership to this team
        await User.updateMany(
            { 'organizationMemberships.organizationId': id },
            { $pull: { 'organizationMemberships.$[t].teams': teamId } },
            { arrayFilters: [{ 't.organizationId': id }] }
        );
    };

    OrganizationSchema.statics.addUserToTeam = async function (id, teamId, userId) {
        // validate that team exists, as mongoose doesn't validate forign key for inner objects using addToSet
        const organization = await Organization.findOne({ _id: id });
        const organizationTeamFound = organization?.teams?.filter((t) => t._id?.equals(teamId)).length === 1;
        if (!organizationTeamFound) {
            throw new ResponseError('NotFound');
        }

        const user = await User.findOneAndUpdate(
            { _id: userId, 'organizationMemberships.organizationId': id },
            { $addToSet: { 'organizationMemberships.$[t].teams': teamId } },
            { arrayFilters: [{ 't.organizationId': id }] }
        );
        if (!user) {
            // user does not exist or does not member of the organization
            throw new ResponseError('NotFound');
        }
    };

    OrganizationSchema.statics.removeUserFromTeam = async function (id, teamId, userId) {
        // validate that team exists, as mongoose doesn't validate forign key for inner objects using pull
        const organization = await Organization.findOne({ _id: id });
        const organizationTeamFound = organization?.teams?.filter((t) => t._id?.equals(teamId)).length === 1;
        if (!organizationTeamFound) {
            throw new ResponseError('NotFound');
        }

        const user = await User.findOneAndUpdate(
            { _id: userId, 'organizationMemberships.organizationId': id },
            { $pull: { 'organizationMemberships.$[t].teams': teamId } },
            { arrayFilters: [{ 't.organizationId': id }] }
        );
        if (!user) {
            // user does not exist or does not member of the organization
            throw new ResponseError('NotFound');
        }
    };
};
