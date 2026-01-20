import { Empty, Typography } from 'antd'
import emptyIcon from '../assets/icons/empty.svg'
import { ReactElement } from 'react'

const EmptyState = (): ReactElement => {
  return (
    <Empty
      image={emptyIcon}
      imageStyle={{ height: 60 }}
      description={
        <Typography.Text style={{ fontSize: 13, color: '#999999', fontWeight: 'bold' }}>
          暂无数据
        </Typography.Text>
      }
    />
  )
}

export default EmptyState
